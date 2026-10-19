# RebuttalForge

A review-first PayPal dispute workspace. It gathers evidence, asks a configured AI model for a cited assessment, checks response policy, and separates human approval from execution. Missing evidence can produce a hold instead of an unsupported draft.

**Sandbox only.** The client rejects PayPal's live host. This release contains the reviewed October 18 application and its matching built interface. No account credentials or private case data are included.

## Run the functional local demo for free

The local demo runs the actual application backend and frontend with an embedded PayPal-compatible simulator and explicitly scripted model responses. No PayPal account, API key, AI subscription or payment is required. It supports evidence review, reassessment, approval and simulated execution; it does not make live PayPal or AI requests.

Prerequisites: Node.js 24 LTS, npm and Python 3 (Python is used only by branding verification or the optional static preview). The reviewed environment used Node 24.19.0. Commands below use a POSIX shell on macOS/Linux or Windows WSL. Ports 4000, 4010 and 5173 must be available.

Download this repository or clone it, then run from its root:

```sh
npm ci --ignore-scripts
npm --prefix web ci --ignore-scripts
```

Dependency installation needs registry access. Then use four terminals in the same repository directory:

1. Start the local PayPal simulator and keep it running:

```sh
SIM_PORT=4010 SIM_WEBHOOK_URL=http://127.0.0.1:4000/webhooks/paypal npm run simulator
```

2. Start the application backend in scripted mode and keep it running:

```sh
PAYPAL_BASE_URL=http://127.0.0.1:4010 PAYPAL_CLIENT_ID=simulator PAYPAL_CLIENT_SECRET=simulator PAYPAL_WEBHOOK_ID=WH-LOCAL AI_PROVIDER= ANTHROPIC_API_KEY= NVIDIA_API_KEY= DISPUTE_DESK_TEST_DOUBLE=1 DISPUTE_DESK_OPERATOR_TOKEN= HOST=127.0.0.1 PORT=4000 DATABASE_PATH=:memory: SELLER_RECORDS_DIR=rehearsal/judge-seller-records npm run dev
```

3. Seed two synthetic disputes after both servers are ready:

```sh
PAYPAL_BASE_URL=http://127.0.0.1:4010 PAYPAL_CLIENT_ID=simulator PAYPAL_CLIENT_SECRET=simulator DISPUTE_DESK_URL=http://127.0.0.1:4000 SELLER_RECORDS_DIR=rehearsal/judge-seller-records npm run seed:simulator
```

4. Start the frontend and keep it running:

```sh
npm --prefix web run dev -- --host 127.0.0.1
```

Open http://127.0.0.1:5173/ without `?fixtures`. Confirm the simulator/scripted-model labels. Open each dispute, inspect its evidence and recommendation, and review the separate approval and execution steps. A simulated refund changes only local simulator state. Stop the three servers with Ctrl+C. The in-memory cases disappear on shutdown; seed them again after restarting.

If a port is occupied, stop your earlier instance before retrying. If cases are absent, confirm the seed command completed after the backend and simulator started. Do not reuse an unrelated service on these ports.

## One-command local workflow check

After dependency installation, with port 4010 free and the interactive demo stopped:

```sh
npm run rehearsal:simulator
```

This starts the actual HTTP backend with an embedded simulator, runs both existing workflows and exits. It ignores `.env`, overrides inherited provider settings with synthetic credentials/scripted AI, and writes synthetic records under `rehearsal/records/`. Ordinary `npm run rehearsal` can use configured providers and is not the account-free command.

## Optional disconnected interface preview

The prebuilt frontend is included under `web/dist`, with its required notices and fonts. No npm install is necessary to view it:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory web/dist
```

Open http://127.0.0.1:4173/?fixtures. This is a disconnected scripted interface preview, not the functional backend demo above or genuine AI. The narrated demonstration shows this explicitly labeled interface.

## Genuine PayPal sandbox and AI integration

The application includes direct PayPal REST and NVIDIA/Anthropic model adapters. Real integration requires an authorized PayPal sandbox REST app with Customer Disputes access and an authorized model configuration. Configure the blank variables in `.env.example` privately, using an operator token for credential-backed operation. Never publish credentials or use live PayPal credentials.

For NVIDIA, select `AI_PROVIDER=nvidia`, configure `NVIDIA_API_KEY`, and optionally set `NVIDIA_MODEL` (default `z-ai/glm-5.3`). For Anthropic, select `AI_PROVIDER=anthropic` and configure its corresponding API key/model. Clear `DISPUTE_DESK_TEST_DOUBLE`. The selected provider does not silently fall back to scripted responses. Provider usage may incur charges; the account-free demo above does not use these providers.

Start `npm run dev` and `npm --prefix web run dev -- --host 127.0.0.1` in separate terminals using that private configuration. Import a known eligible item-not-received sandbox dispute through the interface. Its seller capture must be retrievable with Payments v2 and identify an Orders v2 order with exactly one purchase unit containing the same capture ID. A Send Money transaction without this linkage is unsupported. Import/reassess reads PayPal and sends relevant transaction/evidence details to the selected model; obtain the necessary data and usage authorization. It does not execute a dispute response. Approval and execution remain separate.

One earlier runtime completed a genuine PayPal-to-NVIDIA assessment that returned a missing-fulfillment-evidence hold, with no draft and no PayPal response. That result is not an end-to-end live verification of this release. The current release's backend checks use synthetic providers and mocked model responses. Free access to the optional genuine-model path is not bundled or promised; judges can run the functional simulator without credentials.

## Verification and release identity

Previously completed checks on the matching application: 412 tests, 37 offline backend checks, 14 offline UI checks, typechecks/build, pinned build identity, notices/branding checks, and two simulated HTTP workflows. These are retained results, not a new live-provider test or clean-install claim.

```sh
npm run verify:local
```

This runs the local checks and rebuilds the frontend. `verification/current-build-manifest.json` pins 71 source inputs and 28 build files; its check does not rewrite expected hashes. `RELEASE-MANIFEST.json` lists the files distributed in this public source snapshot. The runtime source and matching build are unchanged from the reviewed application; release documentation is updated and private working material is omitted.

The separate `npm run verify:preview` checks an older historical recording and is expected to fail on its changed JavaScript/HTML. Consequently `npm run verify` includes that historical check and is not the recommended current-release check. The October 18 narrated demonstration was separately checked against the current interface; do not rewrite the historical comparator to manufacture a pass.

## Safety boundaries and limitations

- Only item-not-received disputes are assessed. Unsupported response types require direct PayPal review.
- A citation establishes a source reference, not factual truth. Seller records and tracking linkage are assertions, not proof of carrier delivery.
- Tracking-backed drafts must copy canonical carrier and tracking fields retained together on supporting fulfillment evidence for the disputed capture.
- Human review, revision-bound approval and a separate execution request are required. A hold prevents unsupported action. Unknown execution outcomes require manual reconciliation rather than blind retry.
- API mutations require the public `X-RebuttalForge-Request: operator` CSRF marker; configured Bearer authentication is independent. Default allowed browser origins are exactly `http://localhost:5173` and `http://127.0.0.1:5173`.
- The tokenless server binds to loopback. Loopback does not identify a human operator; use a private operator token for credential-backed operation and before any exposure beyond the machine.
- Existing environment-variable names remain for compatibility and are not product display names.

## License

Project code is MIT-licensed; see [LICENSE](LICENSE). Bundled fonts and runtime dependencies retain their own licenses in `web/public/licenses` and `web/dist/licenses`, with a Third-party notices link in the interface. APIMatic reference licensing is preserved in [docs/APIMATIC-LICENSE.txt](docs/APIMATIC-LICENSE.txt).
