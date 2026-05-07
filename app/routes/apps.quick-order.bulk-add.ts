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

async function cartLinesAddWithRetry(
  storefront: StorefrontClient,
  cartId: string,
  lines: IncomingLine[],
) {
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const body = await safeGraphql(storefront, addLinesMutation, {
        cartId,
        lines,
      });
      const payload = body?.data?.cartLinesAdd;

      if (!payload) {
        const message = body?.errors?.[0]?.message || "Unknown Storefront API error";
        lastError = message;
      } else if ((payload.userErrors || []).length > 0) {
        lastError = payload.userErrors
          .map((e: { message: string }) => e.message)
          .join("; ");
        // userErrors are validation failures; retry rarely helps. Bail out.
        return { ok: false, error: lastError, cart: payload.cart || null };
      } else {
        return { ok: true, cart: payload.cart || null };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Request failed";
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_BASE_MS * (attempt + 1));
    }
  }

  return { ok: false, error: lastError || "Unable to add lines", cart: null };
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

    const batches = chunk(normalizedLines, MAX_LINES_PER_CALL);
    for (const batch of batches) {
      const result = await cartLinesAddWithRetry(storefront, cartId, batch);
      if (result.ok) {
        addedCount += batch.length;
        if (result.cart) lastCart = result.cart;
        continue;
      }

      console.warn(
        `[bulk-add] batch of ${batch.length} lines failed:`,
        result.error,
      );

      batch.forEach((line) => {
        failed.push({
          merchandiseId: line.merchandiseId,
          quantity: line.quantity,
          reason: result.error || "Batch failed",
        });
      });
    }

    return json({
      ok: failed.length === 0,
      cartCreated: created,
      cartId,
      addedCount,
      failedCount: failed.length,
      totalCount: normalizedLines.length,
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
