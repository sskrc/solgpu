# SolGPU — Rent and lend GPUs for SOL (Solana Devnet, with escrow)

[日本語](README.md) | **English**

AI demand has made GPUs scarce, yet the GPUs in personal PCs sit idle most of the time.
SolGPU is a GPU marketplace where **anyone can list their own GPU and anyone can rent one by the minute**.
Listings and rentals are managed by a **Solana program written with Anchor**, and payments are protected by **escrow**.

- Lenders: start the agent → **it benchmarks your GPU and suggests a reference price** → keep that price or set your own, then list with Phantom
- Renters: pick a GPU from the list → choose how many minutes → pay into escrow → **use that GPU from Jupyter Lab in your browser**
- When the rental ends, the program pays the lender. If the lender never starts it, the renter gets a **full refund**

> ⚠️ **Devnet (test network) only.** No real SOL moves.

The web app can be switched between Japanese and English with the **日本語 / EN** toggle at the top right (or open it with `?lang=en`).

---

## How it works

```
 Lender's PC                          SolGPU program (Solana Devnet)                  Renter's browser
┌───────────────────────┐          ┌──────────────────────────────┐          ┌──────────────────┐
│ SolGPU agent           │          │ Listing                       │ ◀─ list ─ │ SolGPU web app    │
│  - benchmark           │          │   payout, price, agent URL    │          │ (GitHub Pages)    │
│  - operator key        │ ─accept─▶ │ Rental (escrow account)       │ ◀─ pay ── │  signs w/ Phantom │
│  - start/stop Jupyter  │ ─settle─▶ │   holds payment, pays lender  │ ─refund─▶ │                  │
│                       │ ◀──────── start request (secret) / Jupyter URL (HTTPS, Cloudflare Tunnel) ──────── │
└───────────────────────┘          └──────────────────────────────┘          └──────────────────┘
```

### Program instructions (`program/programs/solgpu-market/src`)

| Instruction | Who | What it does |
| --- | --- | --- |
| `create_listing` | Lender | Creates a listing (payout wallet, agent key, URL, GPU name, performance, price) |
| `update_agent` | Lender / agent | Updates the agent URL and whether it accepts rentals (automatic when the agent starts or stops) |
| `update_listing` | Lender | Changes price, performance or agent key (only with no unsettled rentals) |
| `close_listing` | Lender | Removes the listing and reclaims the deposit (only with no unsettled rentals) |
| `rent_gpu` | Renter | Pays the price (price × minutes) into an **escrow account**. The GPU is reserved for 5 minutes as "waiting to start" |
| `accept` | Agent | Records "started" once Jupyter is ready. The clock starts here |
| `settle` | Anyone | Settles after the end time. Payment **always goes to the lender**; the account deposit goes back to the renter |
| `refund` | Renter any time / others after the deadline | Cancels a rental that has not started. Payment **always goes back to the renter** |

### Safety measures

- **The program fixes where money goes**: settlement pays the payout wallet set at listing time, refunds go to the renter. Even a stolen agent key cannot move the funds
- **The program computes the price**: `price × minutes` is calculated on-chain and the transaction fails if it differs from the price the renter saw
- **One renter per GPU**: while waiting to start or in use, nobody else can rent it (`busy_until`)
- **Refund if not started**: if the agent does not `accept` within 5 minutes, anyone can trigger a refund and the renter gets the money back
- **Anyone can settle**: even if the agent stops, either the renter or the lender can press Settle after the rental ends
- **Renter verification**: the rental account stores the hash of a secret only the renter knows. The agent hands the Jupyter URL only to whoever presents the matching secret
- **Takeover protection**: an agent binds only to listings created through its own listing link (one-time code), and the list shows only listings the agent itself has confirmed

### Honest limitations (demo constraints)

- **It cannot prove the GPU was actually usable**: the program can only verify that the agent recorded a start. If the lender stops the GPU after that, the lender still gets paid (reputation and proof of usage are future work)
- **Benchmarks are self-reported**: the value measured by the agent is used as is
- It relies on **Cloudflare Tunnel**, a central service
- Renters receive the GPU environment using a secret stored in their browser. Clearing browser data means Jupyter can no longer be opened (refunds and settlement still work from any browser)

### Pricing

The agent runs matrix multiplications with PyTorch (fp16 on GPU, fp32 on CPU) and measures performance in TFLOPS.

```
Reference price (per minute) = measured TFLOPS × 0.000002 SOL (minimum 0.00001 SOL / min)
```

Example: Intel Arc 140T (about 13 TFLOPS) → about 0.000026 SOL / min (about 0.0016 SOL per hour)

- The listing page starts with the reference price, and **you can set anything from 0.00001 to 1 SOL / min**. After listing, you can change it with "Change price" under "Your listings" (when there are no unsettled rentals)
- In the renter's list, the listing price is shown prominently, with the reference price and "◯ SOL above / below reference (±◯%)" underneath

---

## Project layout

| Path | Contents |
| --- | --- |
| `program/` | **Anchor program** (Rust) and tests |
| `program/programs/solgpu-market/src/instructions/` | Listing, rental and escrow instructions |
| `program/programs/solgpu-market/tests/test_market.rs` | Tests (happy path, invalid operations, refunds after expiry, etc.) |
| `program/build.sh` | Build, test and deploy (WSL / Linux) |
| `src/lib/program.ts` | Calls the program from the web app |
| `src/lib/i18n.ts` | Japanese / English switching |
| `src/pages/Market.tsx` | Rent a GPU |
| `src/pages/MyRentals.tsx` | My rentals (open Jupyter, refund, settle) |
| `src/pages/Lend.tsx` | Lend your GPU (list, remove, settle) |
| `src/pages/Transfer.tsx` | Send SOL (send SOL to any address and amount) |
| `src/astryx-themes.ts` | UI theme ([Astryx](https://www.npmjs.com/package/@astryxdesign/core) Gothic, generated by `npx astryx theme`) |
| `src/slides/` / `slides.html` | Presentation slides (built with the same Astryx as the app). Content in `Deck.tsx`, speaker notes in `notes.json` |
| `scripts/export-slides.mjs` | Exports the slides to PDF / PowerPoint (`npm run slides:export`) |
| `agent/solgpu_agent.py` | The lender agent |
| `agent/chain.py` | Calls the program from the agent (accept / settle) |
| `agent/runtime.py` | Benchmark, Jupyter, tunnel and process management |
| `agent/streamdiffusion/` | StreamDiffusion demo (dedicated kernel setup `setup.sh`, notebook, `sd_demo.py`) |
| `scripts/e2e-local.ts` | End-to-end test against a local validator |
| `.github/workflows/deploy.yml` | Automatic deployment to GitHub Pages |

---

## 1. Common setup (first time only)

1. **Node.js**: the LTS version (v22.12 or later) from [https://nodejs.org/](https://nodejs.org/)
2. **Phantom**: install the extension from [https://phantom.com/download](https://phantom.com/download), turn on "Settings → Developer Settings → **Testnet Mode**" and choose **Solana Devnet**
3. **Devnet SOL**: get Devnet SOL for your address at [https://faucet.solana.com/](https://faucet.solana.com/)

## 2. Run the web app

```bash
cd solgpu
npm install      # first time only
npm run dev
```

Open `http://localhost:5173/` in a browser with Phantom installed.

---

## 3. Lend a GPU (lender)

### 3-1. Requirements

- Git
- Python 3.10–3.12 (on Windows, check "Add python.exe to PATH" during installation)
- cloudflared (to expose the agent to the internet): on Windows, `winget install --id Cloudflare.cloudflared -e`. On Linux, `setup.sh` installs it for you
- An up-to-date GPU driver

### 3-2. Clone from GitHub and set up (first time only)

Windows (PowerShell):

```powershell
git clone https://github.com/sskrc/solgpu.git
cd solgpu\agent
.\setup.bat intel     # Intel Arc / Core Ultra integrated GPU (e.g. Arc 140T)
# .\setup.bat nvidia  # NVIDIA GPU
# .\setup.bat cpu     # no GPU
```

Linux / macOS:

```bash
git clone https://github.com/sskrc/solgpu.git
cd solgpu/agent
bash setup.sh nvidia   # NVIDIA GPU (older GPUs such as V100 / P100 get the cu126 PyTorch build automatically)
# bash setup.sh intel  # Intel GPU
# bash setup.sh cpu    # no GPU (on macOS, cpu also uses the Apple GPU)
```

### 3-3. Start and list

```powershell
.\start.bat                                                # Windows
```

```bash
.venv/bin/python solgpu_agent.py --i-understand-the-risk   # Linux / macOS
```

1. On first run, a benchmark runs and sets the price (rerun it with `start.bat --rebench`)
2. The listing page opens in your browser. Connect Phantom, click "List with this wallet" and approve
   - You pay a listing deposit of about 0.003 SOL (returned when you remove the listing) and 0.01 SOL for the agent's fees
3. Once it appears on the "Rent a GPU" tab, you are done. **From then on, just run the start command**: the agent writes its new URL and starts accepting rentals again automatically
4. Stop with `Ctrl + C` (it records "not accepting" automatically)
5. Under "Your listings" on the "Lend your GPU" tab you can remove listings and settle

> The agent's key is saved in `agent/data/operator.json`. If you delete it, you need to create the listing again.

### 3-4. For demos: StreamDiffusion (NVIDIA GPU, Linux, optional)

When a renter opens Jupyter, **the StreamDiffusion notebook is shown from the start**. Running the cell and pressing the "▶ 生成開始" (start) button begins real-time image generation (sd-turbo, 512×512) on the rented GPU. Edits to the prompt show up in the images immediately.

```bash
cd agent
./setup.sh nvidia            # set up the agent first if you have not yet
./streamdiffusion/setup.sh   # create and register the dedicated kernel (Python 3.11 env) and download the models
```

- StreamDiffusion pins `diffusers==0.24.0`, so it is installed in a separate environment, `agent/streamdiffusion/.venv`, and registered as the Jupyter kernel **"StreamDiffusion (GPU)"**
- When it is ready, the agent prints "StreamDiffusion デモ: 有効" (demo enabled) on startup. Otherwise it opens an empty Jupyter Lab as before
- Reference speed: about 14–16 images per second on a Tesla V100

### ⚠️ Safety

Renters can **run any code on your PC** through Jupyter. It runs in a dedicated folder (`agent/sessions/`) with the terminal disabled, but **it is not fully isolated**. Run it only during the demo, on a PC without important data. To try it only on your own PC, use `start.bat --no-tunnel`.

---

## 4. Rent a GPU (renter)

1. On the "Rent a GPU" tab, pick a GPU and enter the rental time (minutes)
2. Click "Rent (pay into escrow)" → approve in Phantom
3. On the "My rentals" tab, wait for the lender to get ready (10–30 seconds) → **"Open Jupyter"**
4. Use the GPU in Jupyter (e.g. `device="xpu"` for Intel Arc, `"cuda"` for NVIDIA)
   ```python
   import torch
   x = torch.randn(4096, 4096, device="xpu")
   print((x @ x).sum())
   ```
5. When time is up, the environment stops and the lender is paid automatically

**Refunds**: before it starts, use "Cancel and refund". If the lender did not start within 5 minutes, "Get refund" returns the full amount.

---

## 5. Build, test and deploy the program (developers)

Install Rust, the Solana CLI and Anchor 1.2.2 in WSL (Ubuntu), then run:

```bash
# in WSL
bash program/build.sh          # build + test (LiteSVM; also advances the clock to test expiry)
bash program/build.sh deploy   # + deploy to Devnet (the deploy wallet needs about 2.2 SOL)
```

- **Built for SBPF v0**: Anchor 1.2.2 defaults to SBPF v3, but v3 is not yet enabled on Devnet (as of November 2026)
- The program address key and deploy wallet live in `program/.keys/` (not committed to git)
- End-to-end test on a local validator:
  ```bash
  # in WSL
  solana-test-validator --reset --bpf-program <PROGRAM_ID> ~/solgpu-build/target/deploy/solgpu_market.so
  # on Windows
  node scripts/e2e-local.ts
  ```
  To point the web app at the local validator, put `VITE_RPC_URL=http://127.0.0.1:8899` in `.env.local`

---

## UI and slide design

The UI is built from the components and themes of **Astryx** (`@astryxdesign/core`), a Meta design system. There is no custom CSS.

- Component usage: `npx astryx component <Name>`; overall rules: `AGENTS.md`
- Changing the theme: `npx astryx theme list` → `npx astryx theme add <name>` → `npx astryx theme use <name>`
- Slides: run `npm run dev` and open `http://localhost:5173/slides.html`. After editing, `npm run slides:export` writes a PDF and a pptx (with speaker notes) to `Sorana発表資料/` (requires Microsoft Edge)
- UI text: every string is written as `t('日本語', 'English')` (`src/lib/i18n.ts`). The language follows `?lang=`, then the last choice, then the browser language

## 6. Other: Send SOL

The "Send SOL" tab lets you send any amount of SOL to any address.

## 7. Common errors

| Message | Cause and fix |
| --- | --- |
| The request was cancelled in the wallet | You pressed "Cancel" in Phantom |
| Insufficient balance | Get Devnet SOL from the faucet |
| The Devnet RPC is busy | The public Devnet RPC is rate limited. Wait a moment and retry |
| This GPU is in use or someone else is waiting for it to start | Someone else is using it |
| The price has changed | Refresh the list and try again |
| The start deadline has passed | Get a refund from "My rentals" |
| It has unsettled rentals, so it cannot be removed | Remove it after settlement or refund |
| `この出品リンクは古いか…` (the listing link is outdated or belongs to another agent) | Open the latest link printed by the agent |
| `cloudflared が見つかりません` (cloudflared not found) | Run `winget install --id Cloudflare.cloudflared -e` and reopen PowerShell |

> Messages that come from the agent itself (the last two rows) are in Japanese, even when the web app is set to English.

---

## 8. Publish on GitHub Pages

With `.github/workflows/deploy.yml`, **pushing to the main branch builds and publishes automatically** (only the web app is published).

1. In the repository's **Settings → Pages**, set Source to **GitHub Actions**
2. Wait for "Deploy to GitHub Pages" to turn green in the **Actions** tab
3. Public URL: `https://<user>.github.io/<repository>/`
4. The agent's listing link points to the public site (`https://sskrc.github.io/solgpu/`) by default. To use a local dev server, start it with `--site http://localhost:5173/`

> Using Pages with a private repository requires a paid GitHub plan.

---

## Estimated costs

| Item | Devnet | Mainnet (approx.) |
| --- | --- | --- |
| Deploying the program | Free with faucet SOL | About 1.1 SOL (deposit, returned when the program is closed) |
| One listing | Free | About 0.003 SOL (deposit, returned when removed) |
| One rental | Free | About 0.002 SOL (deposit, returned to the renter at the end) + the rental price |
| Transaction fee | Free | About 0.000005 SOL each |
