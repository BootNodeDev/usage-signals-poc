// Seeded tenants and sites. Ids are fixed so the demo pages and the tests can name them.

/** The Sec-Fetch headers a browser sends with the tracker's fetch(); a test visitor without them is flagged. */
export const FETCH_METADATA = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
export const TENANTS = [
  {
    id: 'a0000000-0000-4000-8000-000000000001',
    name: 'Aurora Wallet',
    status: 'active',
    site: {
      id: 'a0000000-0000-4000-8000-0000000000a1',
      slug: 'aurora-wallet',
      domain: 'localhost:4301',
      umamiWebsiteId: 'a0000000-0000-4000-8000-0000000000aa',
    },
  },
  {
    id: 'b0000000-0000-4000-8000-000000000002',
    name: 'Blend Explorer',
    status: 'active',
    site: {
      id: 'b0000000-0000-4000-8000-0000000000b1',
      slug: 'blend-explorer',
      domain: 'localhost:4302',
      umamiWebsiteId: 'b0000000-0000-4000-8000-0000000000bb',
    },
  },
  {
    id: 'c0000000-0000-4000-8000-000000000003',
    name: 'Comet Pay',
    status: 'suspended',
    site: {
      id: 'c0000000-0000-4000-8000-0000000000c1',
      slug: 'comet-pay',
      domain: 'localhost:4303',
      umamiWebsiteId: 'c0000000-0000-4000-8000-0000000000cc',
    },
  },
  {
    id: 'd0000000-0000-4000-8000-000000000004',
    name: 'Drift Markets',
    status: 'active',
    site: {
      id: 'd0000000-0000-4000-8000-0000000000d1',
      slug: 'drift-markets',
      domain: 'drift.example',
      umamiWebsiteId: 'd0000000-0000-4000-8000-0000000000dd',
    },
  },
];
