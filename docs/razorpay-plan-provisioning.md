# Razorpay Plan provisioning

The billing catalog needs one Razorpay Plan for each supported region, plan and
billing cycle. The provisioning command creates those Plans in the environment
selected by `RAZORPAY_MODE` and writes the resulting Plan IDs back into
`BILLING_PLAN_CATALOG_JSON`.

```bash
cd backend
npm run razorpay:plans -- --dry-run
npm run razorpay:plans -- --write-env
```

The command is test-mode safe by default. It refuses to make live changes unless
`RAZORPAY_MODE=live` and `--allow-live` are both present. It never prints a key
secret. `--write-env` only updates the catalog line in the selected env file;
when the backend is deployed with platform-managed environment variables, copy
the printed `BILLING_PLAN_CATALOG_JSON` value into that platform instead.

The environment value must be the raw JSON array beginning with `[` and ending
with `]`; do not paste a JSON-stringified value containing literal `\\"` sequences.

## API contract used

Razorpay's Plans API is `POST /v1/plans`. The request uses:

```json
{
  "period": "monthly",
  "interval": 1,
  "item": {
    "name": "Starter - Monthly",
    "amount": 99900,
    "currency": "INR",
    "description": "..."
  },
  "notes": {
    "catalog_key": "couture:IN:starter:monthly"
  }
}
```

Annual billing is represented as `period: "yearly"` and `interval: 1`. Amounts
are sent in the smallest currency unit: paise for INR and cents for USD. For
India, the catalog amount is already the GST-inclusive customer total. For US
plans, the script uses the backend quote total, so a configured tax amount is
also reflected in the provider Plan.

Plans are immutable after creation, so the script validates an existing Plan's
frequency, amount and currency rather than attempting to edit it. It records a
stable catalog key in Plan notes and checks the list endpoint before creating a
missing ID. This makes a rerun safe if the first run created a Plan but did not
finish writing the env file.

References:

- [Razorpay: Create and View Plans](https://razorpay.com/docs/payments/subscriptions/create-plans/)
- [Razorpay API: Create a Plan](https://razorpay.com/docs/api/payments/subscriptions/create-plan/)
- [Razorpay API: Fetch All Plans](https://razorpay.com/docs/api/payments/subscriptions/fetch-all-plans/)
- [Razorpay API: Fetch a Plan](https://razorpay.com/docs/api/payments/subscriptions/fetch-a-plan/)
