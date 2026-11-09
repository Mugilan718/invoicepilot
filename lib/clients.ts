import clientsData from "@/data/clients.json";

export interface Client {
  name: string;
  email: string;
}

const EMAIL_PLACEHOLDER = "{{PAYPAL_TEST_CUSTOMER_EMAIL}}";

/**
 * Demo clients. Every email is replaced with the sandbox personal account at runtime,
 * because that is the only account that can receive sandbox invoices.
 */
export function getClients(): Client[] {
  const testEmail = process.env.PAYPAL_TEST_CUSTOMER_EMAIL;
  return clientsData.map((c) => {
    if (c.email !== EMAIL_PLACEHOLDER) return c;
    if (!testEmail) {
      throw new Error(
        "Missing PAYPAL_TEST_CUSTOMER_EMAIL. Set it in .env.local and restart the dev server."
      );
    }
    return { name: c.name, email: testEmail };
  });
}

/** Case-insensitive lookup: exact name match first, then a unique partial match. */
export function findClient(query: string): Client | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const clients = getClients();
  const exact = clients.find((c) => c.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = clients.filter(
    (c) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase())
  );
  return partial.length === 1 ? partial[0] : null;
}
