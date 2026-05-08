import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

type IncomingLine = {
  merchandiseId: string;
  quantity: number;
};

type FailedLine = {
  merchandiseId: string;
  quantity: number;
  reason: string;
};

const MAX_LINES_PER_CALL = 250;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cartCreateMutation = `#graphql
  mutation CartCreate($input: CartInput) {
    cartCreate(input: $input) {
      cart {
        id
        totalQuantity
        checkoutUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const addLinesMutation = `#graphql
  mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) {
      cart {
        id
        totalQuantity
        checkoutUrl
      }
      userErrors {
        field
        message
      }
      warnings {
        code
        message
        target
      }
    }
  }
`;

const cartQuery = `#graphql
  query GetCart($cartId: ID!) {
    cart(id: $cartId) {
      id
      totalQuantity
      checkoutUrl
    }
  }
`;

type StorefrontClient = {
  graphql: (
    query: string,
    init?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type CartSummary = {
  id?: string;
  totalQuantity?: number;
  checkoutUrl?: string;
} | null;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function safeGraphql(
  storefront: StorefrontClient,
  query: string,
  variables: Record<string, unknown>,
) {
  const result = await storefront.graphql(query, { variables });

  // Different versions of @shopify/shopify-app-react-router return different
  // shapes from `graphql()`:
  //   - Older: a fetch Response object (must call .json())
  //   - Newer: the already-parsed { data, errors, extensions } object
  // Handle both so we never blow up trying to .json() a plain object.
  if (result && typeof (result as Response).json === "function") {
    try {
      return await (result as Response).json();
    } catch (parseError) {
      console.error("[bulk-add] Failed to parse GraphQL JSON response:", parseError);
      throw parseError;
    }
  }
  return result;
}

async function ensureCart(
  storefront: StorefrontClient,
  incomingCartId: string | null | undefined,
): Promise<{ cart: CartSummary; created: boolean; error?: string }> {
  // Validate the existing cart still exists.
  if (incomingCartId) {
    try {
      const body = await safeGraphql(storefront, cartQuery, { cartId: incomingCartId });
      const existing = body?.data?.cart;
      if (existing && existing.id) {
        return { cart: existing as CartSummary, created: false };
      }
    } catch {
      // Fall through to create a fresh cart.
    }
  }

  try {
    const body = await safeGraphql(storefront, cartCreateMutation, { input: {} });
    const payload = body?.data?.cartCreate;
    if (!payload) {
      return {
        cart: null,
        created: false,
        error: body?.errors?.[0]?.message || "Failed to create cart",
      };
    }
    const errs = payload.userErrors || [];
    if (errs.length) {
      return {
        cart: null,
        created: false,
        error: errs.map((e: { message: string }) => e.message).join("; "),
      };
    }
    return { cart: payload.cart as CartSummary, created: true };
  } catch (error) {
    return {
      cart: null,
      created: false,
      error: error instanceof Error ? error.message : "Failed to create cart",
    };
  }
}

type CartUserError = {
  field?: string[] | null;
  message: string;
};

type CartWarning = {
  code: string;
  message: string;
  target?: string | null;
};

type LineAddBatchResult = {
  ok: boolean;
  cart: CartSummary | null;
  // Per-line failures keyed by line index in the batch (not by merchandiseId
  // because the same merchandise can appear in multiple lines). Used by the
  // caller to mark individual lines as failed without failing the whole
  // batch. Falls back to `error` (string) for transport errors.
  perLineFailures: Map<number, string>;
  // Warnings keyed by merchandiseId so we can attach them to the right line
  // even though Shopify's warnings don't directly reference line indexes.
  warningsByMerchandise: Map<string, string[]>;
  // Bulk transport / network error for the entire batch.
  batchError: string | null;
};

function indexFromUserErrorField(field: string[] | null | undefined): number | null {
  // Field paths look like: ["lines", "3", "quantity"] or ["lines", "0"]
  if (!Array.isArray(field) || field.length < 2 || field[0] !== "lines") return null;
  const idx = Number(field[1]);
  return Number.isFinite(idx) ? idx : null;
}

async function cartLinesAddWithRetry(
  storefront: StorefrontClient,
  cartId: string,
  lines: IncomingLine[],
): Promise<LineAddBatchResult> {
  let batchError: string | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const body = await safeGraphql(storefront, addLinesMutation, {
        cartId,
        lines,
      });
      const payload = body?.data?.cartLinesAdd;

      if (!payload) {
        batchError = body?.errors?.[0]?.message || "Unknown Storefront API error";
      } else {
        const perLineFailures = new Map<number, string>();
        const warningsByMerchandise = new Map<string, string[]>();

        // Map userErrors back to specific line indexes when possible.
        (payload.userErrors || []).forEach((err: CartUserError) => {
          const idx = indexFromUserErrorField(err.field);
          if (idx !== null && idx >= 0 && idx < lines.length) {
            const existing = perLineFailures.get(idx);
            perLineFailures.set(
              idx,
              existing ? `${existing}; ${err.message}` : err.message,
            );
          } else {
            // Unattributable userError: treat as full-batch failure.
            batchError = batchError
              ? `${batchError}; ${err.message}`
              : err.message;
          }
        });

        // Warnings attach to a specific merchandiseId.
        (payload.warnings || []).forEach((warning: CartWarning) => {
          const target = warning.target || "";
          const list = warningsByMerchandise.get(target) || [];
          list.push(`${warning.code}: ${warning.message}`);
          warningsByMerchandise.set(target, list);
        });

        // If we have an unattributable batch error and zero per-line errors
        // mapped, retry. Otherwise we have actionable info and should return.
        if (batchError && perLineFailures.size === 0 && attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_MS * (attempt + 1));
          continue;
        }

        return {
          ok: perLineFailures.size === 0 && !batchError,
          cart: (payload.cart as CartSummary) || null,
          perLineFailures,
          warningsByMerchandise,
          batchError,
        };
      }
    } catch (error) {
      batchError = error instanceof Error ? error.message : "Request failed";
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_BASE_MS * (attempt + 1));
    }
  }

  return {
    ok: false,
    cart: null,
    perLineFailures: new Map(),
    warningsByMerchandise: new Map(),
    batchError: batchError || "Unable to add lines",
  };
}

export async function action({ request }: ActionFunctionArgs) {
  console.log(
    `[bulk-add] action invoked: ${request.method} ${request.url}`,
  );

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    let storefront: StorefrontClient | undefined;
    try {
      const auth = await authenticate.public.appProxy(request);
      storefront = auth.storefront as StorefrontClient | undefined;
      console.log(
        `[bulk-add] appProxy auth OK; storefront client present: ${Boolean(storefront)}`,
      );
    } catch (authError) {
      const message =
        authError instanceof Error ? authError.message : "App proxy auth failed";
      console.error("[bulk-add] appProxy authentication failed:", authError);
      return json({ error: `App proxy auth failed: ${message}` }, 401);
    }

    if (!storefront) {
      console.error(
        "[bulk-add] storefront client unavailable. Ensure the app has unauthenticated_* scopes (e.g. unauthenticated_write_checkouts) and has been re-installed/deployed after adding them.",
      );
      return json(
        {
          error:
            "Storefront client unavailable. The app needs unauthenticated Storefront API scopes (unauthenticated_write_checkouts, unauthenticated_read_product_listings) and must be re-installed on the shop after they are added.",
        },
        500,
      );
    }

    let payload: { cartId?: string | null; lines?: IncomingLine[] };
    try {
      payload = (await request.json()) as {
        cartId?: string | null;
        lines?: IncomingLine[];
      };
    } catch (jsonError) {
      console.error("[bulk-add] Invalid JSON body:", jsonError);
      return json({ error: "Invalid JSON body" }, 400);
    }

    const lines = Array.isArray(payload?.lines) ? payload.lines : [];

    if (!lines.length) {
      return json({ error: "lines must contain at least one item" }, 400);
    }

    const normalizedLines = lines
      .filter((line) => line && typeof line.merchandiseId === "string")
      .map((line) => ({
        merchandiseId: line.merchandiseId.trim(),
        quantity: Number(line.quantity) || 0,
      }))
      .filter((line) => line.merchandiseId && line.quantity > 0);

    if (!normalizedLines.length) {
      return json({ error: "No valid lines to add" }, 400);
    }

    console.log(
      `[bulk-add] processing ${normalizedLines.length} line(s); cartId provided: ${Boolean(payload?.cartId)}`,
    );

    const { cart: ensuredCart, created, error: ensureError } = await ensureCart(
      storefront,
      payload?.cartId ?? null,
    );

    if (!ensuredCart || !ensuredCart.id) {
      console.error("[bulk-add] ensureCart failed:", ensureError);
      return json({ error: ensureError || "Unable to obtain a cart" }, 502);
    }

    console.log(
      `[bulk-add] cart ${created ? "created" : "reused"}: ${ensuredCart.id}`,
    );

    const cartId = ensuredCart.id;
    const failed: FailedLine[] = [];
    let addedCount = 0;
    let lastCart: CartSummary = ensuredCart;
    const expectedTotalQuantity = normalizedLines.reduce(
      (sum, line) => sum + line.quantity,
      0,
    );

    const batches = chunk(normalizedLines, MAX_LINES_PER_CALL);
    for (const batch of batches) {
      const result = await cartLinesAddWithRetry(storefront, cartId, batch);
      if (result.cart) lastCart = result.cart;

      // Successful lines: anything in the batch that didn't get a per-line
      // failure AND didn't get a warning that effectively rejected it.
      batch.forEach((line, lineIdx) => {
        const perLineError = result.perLineFailures.get(lineIdx);
        const warnings = result.warningsByMerchandise.get(line.merchandiseId);

        if (perLineError) {
          failed.push({
            merchandiseId: line.merchandiseId,
            quantity: line.quantity,
            reason: perLineError,
          });
          return;
        }

        if (result.batchError) {
          failed.push({
            merchandiseId: line.merchandiseId,
            quantity: line.quantity,
            reason: result.batchError,
          });
          return;
        }

        if (warnings && warnings.length > 0) {
          // Warnings attach to specific merchandise. Surface as failures so
          // the frontend re-validates rather than silently navigating to a
          // checkout that's missing items.
          failed.push({
            merchandiseId: line.merchandiseId,
            quantity: line.quantity,
            reason: warnings.join("; "),
          });
          return;
        }

        addedCount++;
      });

      if (result.batchError) {
        console.warn(
          `[bulk-add] batch of ${batch.length} lines failed transport:`,
          result.batchError,
        );
      }
    }

    // Final consistency check: did the cart really end up with what we
    // requested? If totalQuantity is short of the expected total, Shopify
    // silently truncated something - report it so the frontend doesn't push
    // the user into a checkout with missing/incorrect items.
    let truncationWarning: string | null = null;
    const actualTotal =
      typeof lastCart?.totalQuantity === "number" ? lastCart.totalQuantity : null;
    if (
      actualTotal !== null &&
      failed.length === 0 &&
      actualTotal < expectedTotalQuantity
    ) {
      truncationWarning = `Cart total quantity is ${actualTotal} but ${expectedTotalQuantity} was requested. Some quantities were silently reduced by Shopify (likely stock or B2B catalog rules).`;
      console.warn(`[bulk-add] ${truncationWarning}`);
    }

    console.log(
      `[bulk-add] done. requested=${normalizedLines.length} added=${addedCount} failed=${failed.length} expectedTotalQty=${expectedTotalQuantity} actualTotalQty=${actualTotal}`,
    );

    return json({
      ok: failed.length === 0 && !truncationWarning,
      cartCreated: created,
      cartId,
      addedCount,
      failedCount: failed.length,
      totalCount: normalizedLines.length,
      expectedTotalQuantity,
      actualTotalQuantity: actualTotal,
      truncationWarning,
      failed,
      cart: lastCart,
    });
  } catch (unhandled) {
    const message =
      unhandled instanceof Error ? unhandled.message : "Unknown server error";
    console.error("[bulk-add] Unhandled error:", unhandled);
    return json({ error: message }, 500);
  }
}
