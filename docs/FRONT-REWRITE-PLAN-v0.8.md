# PrivateTip Front — Clean Rewrite Plan against v0.8 Stack

**Date**: 2026-06-10
**SDK target**: `@claucondor/sdk` 0.8.1-alpha.2
**Contracts target**: openjanus-v08 (`0x4b6bc58bc8bf5dcc` Cadence + JanusFlow EVM `0xA64340C1d356835A2450306Ffd290Ed52c001Ad3` + JanusERC20 mUSDC `0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d`)
**Approach**: Clean rewrite. Nothing legacy survives.

---

## Section 1 — SDK surface to leverage (target API map)

Descubierto leyendo `src/index.ts`, `src/adapters/JanusTokenAdapter.ts`, `src/inbox/ShieldedInboxClient.ts`, `src/checkpoint/ShieldedCheckpointClient.ts`, `src/batchClaim/BatchClaimClient.ts`, `src/types.ts`, y `src/cadence/index.ts`.

| SDK Module | Class / Method | Firma relevante | Cuándo lo usa el front |
|---|---|---|---|
| `sdk` facade | `sdk.token(id)` | `TokenId → JanusTokenAdapter` | En todas las páginas con operaciones de token |
| `adapters/JanusTokenAdapter` | `publishMemoKey(kp, signer)` | `→ TxResult` | `/status` onboarding |
| `adapters/JanusTokenAdapter` | `wrap(params, signer)` | `WrapParams → WrapResult` | `/wrap` |
| `adapters/JanusTokenAdapter` | `shieldedTransfer(params, signer)` | `SendParams → SendResult` (incluye `checkpointPayload?`) | `/send` |
| `adapters/JanusTokenAdapter` | `unwrap(params, signer)` | `UnwrapParams → UnwrapResult` | `/claim` |
| `adapters/JanusTokenAdapter` | `getMemoKey(addr)` | `→ {x,y} \| null` | `/status`, `/send` (recipient check) |
| `adapters/JanusTokenAdapter` | `getCommitment(addr)` | `→ Point` | `/portfolio` |
| `adapters/JanusTokenAdapter` | `getBalance(addr)` | `→ bigint` | `/portfolio` |
| `adapters/JanusTokenAdapter` | `computeNet(gross)` | `→ bigint` | `/wrap` (preview) |
| `adapters/JanusTokenAdapter` | `feeBps()` | `→ number` | `/wrap`, `/claim` (fee display) |
| `inbox/ShieldedInboxClient` | `count(user)` | `→ bigint` | `/portfolio` (pending badge) |
| `inbox/ShieldedInboxClient` | `peekAll(user)` | `→ InboxNote[]` | `/tips` received — modo no-drain |
| `inbox/ShieldedInboxClient` | `drainAll(signer)` | `→ DrainResult` | `/tips` received — modo drain |
| `inbox/ShieldedInboxClient` | `drainAndDecrypt(signer, memoPrivKey)` | `→ DrainAndDecryptResult` | `/tips` received — path canónico |
| `inbox/ShieldedInboxClient` | `drainBatch(limit, signer)` | `→ DrainResult` | Drain parcial antes de batchClaim |
| `checkpoint/ShieldedCheckpointClient` | `exists(user)` | `→ boolean` | `/status` check |
| `checkpoint/ShieldedCheckpointClient` | `metadata(user)` | `→ CheckpointMetadata` | `/portfolio` (versión, cursor) |
| `checkpoint/ShieldedCheckpointClient` | `readAndDecrypt(signer, memoPrivKey)` | `→ SnapshotContent \| null` | `/portfolio`, `/send`, `/claim` |
| `checkpoint/ShieldedCheckpointClient` | `update(payload, cursor, signer)` | `CheckpointPayload + bigint → UpdateResult` | Después de cada wrap/send/unwrap |
| `checkpoint/ShieldedCheckpointClient` | `encryptAndUpdate(snap, cursor, kp, signer)` | convenience wrapper | Después de wrap (state del WrapWithSnapshot event) |
| `batchClaim/BatchClaimClient` | `claimBatch(publicInputs, proof)` | `→ ContractTransactionReceipt` | `/portfolio` — submit prueba pre-generada server-side |
| `batchClaim/BatchClaimClient` | `buildAndClaim(params)` | `BuildAndClaimParams → BuildAndClaimResult` | Solo en Node (zkey 151MB); en el front: prueba via `/api/proof/batch-claim` |
| `batchClaim/BatchClaimClient` | `getVersion()` | `→ string` | `/status` protocol health |
| `cadence/cadenceTx` | `installInboxAndCheckpoint()` | `→ string (Cadence tx)` | `/status` onboarding — paso 3 |
| `cadence/cadenceTx` | `combinedShieldedTransferWithCheckpoint(proxyAddr)` | `→ string (Cadence tx)` | Opcional: atomic send + checkpoint |
| crypto | `deriveMemoKeyFromSignature(bytes)` | `→ BabyJubKeypair` | `/status` derivación de clave |
| crypto | `encryptSnapshot(snap, pubkey)` | `→ {ciphertext, ephemeralPubkey}` | Tras wrap: construir CheckpointPayload |
| crypto | `decryptSnapshot(cipher, eph, priv)` | `→ SnapshotContent` | Parsear evento `WrapWithSnapshot` |
| crypto | `encryptNote / decryptNote` | ECIES sobre `NoteContent` | Server-side si se necesita route explícita |
| crypto | `decryptAnyNote` | Intenta ambos schemas | Compatibilidad con notas antiguas |
| crypto | `generateBlinding()` | `→ bigint` | Nuevo blinding para batchClaim |
| primitives | `computeCommitment(bal, bld)` | `→ Point` | Verificación local post-batchClaim |
| types | `SnapshotContent` | `{balance: bigint, blinding: bigint}` | Estado canónico del checkpoint |
| types | `NoteContent` | `{amount, blinding, memo?}` | Output de `drainAndDecrypt` |
| types | `CheckpointPayload` | `{encryptedSnapshot, ephPubkeyX, ephPubkeyY}` | Retornado por `shieldedTransfer` → `cpClient.update()` |
| types | `InboxNote` | `{ciphertext, ephPubkeyX, ephPubkeyY, depositor, blockNumber}` | `depositor` field clave para multi-token disambiguation |

**Eliminado en v0.8 (NO usar):**
- `adapter.latestSnapshot()` — no existe
- `adapter.scanIncomingNotes()` — no existe
- `adapter.scanDeposits()` — no existe
- `adapter.getFirstSnapshotBlock()` — no existe
- `SnapshotContent.timestampMs` — deprecated, no en v0.8
- `NoteContent.tipId` — eliminado (app-specific, no es del protocolo)

---

## Section 2 — Page-by-page rewrite spec

### 2.1 /status (onboarding + protocol health)

**Comportamiento actual:** 2 pasos — (1) firma wallet para derivar MemoKey privkey en sesión, (2) tx Cadence que hace setup COA + publica MemoKey. Sin inbox, sin checkpoint. Panel de protocol health: totalLocked, versión del contrato.

**Referencia canónica:** `scripts/01-activate.cjs` + `scripts/08-status.cjs`

**Intento v0.8:** 3 pasos de onboarding (todos idempotentes):
1. Firma wallet → deriva BabyJub keypair via `deriveMemoKeyFromSignature` + `/api/memokey/derive`
2. `sdk.token('flow').publishMemoKey(keypair, evmSigner)` — EVM tx registra pubkey en `MemoKeyRegistry`
3. FCL tx `cadenceTx.installInboxAndCheckpoint()` — instala `ShieldedInbox` + `ShieldedCheckpoint` resources en cuenta Cadence

Checklist del estado (para cualquier address):
- `getMemoKey(addr)` → MemoKey publicada
- `ShieldedCheckpointClient.exists(addr)` → Checkpoint instalado
- `ShieldedInboxClient.count(addr)` → Inbox online (cualquier count ≥ 0 implica inbox activo)

**SDK calls:**
- `sdk.token('flow').getMemoKey(addr)`
- `sdk.token('flow').publishMemoKey(keypair, evmSigner)`
- `cadenceTx.installInboxAndCheckpoint()` via `fcl.mutate()`
- `ShieldedCheckpointClient.exists(addr)`
- `BatchClaimClient.getVersion()` para protocol health

**Contract reads/writes:**
- EVM: `MemoKeyRegistry.publishMemoKey(x, y)` (via adapter)
- Cadence: `setup_user.cdc` (o SDK template `installInboxAndCheckpoint`)
- EVM read: `JanusFlow.VERSION()`, `JanusFlow.totalLocked()`, `JanusFlow.feeBps()`, idem `JanusERC20`
- Cadence read: `PrivateTip.getTotalTipCount` (opcional)

**Archivos a DELETE:** Los inline Cadence strings en `tip-actions.ts` (`TX_SMART_SETUP`, `smartSetupAccount`) son reemplazados por `cadenceTx.installInboxAndCheckpoint()`.

---

### 2.2 /wrap

**Comportamiento actual:** `adapter.wrap()` → escribe resultado en localStorage (balance/blinding). Un solo wrap. No acumula correctamente entre múltiples wraps.

**Referencia canónica:** `scripts/03-wrap.cjs` + `scripts/test-accumulation-recovery.cjs`

**Intento v0.8:** `adapter.wrap()` → parsear evento `WrapWithSnapshot(user, amount, encryptedSnapshot, ephPubkeyX, ephPubkeyY)` del receipt → `decryptSnapshot()` → **acumular**: `balance += marginal, blinding += marginal` sobre el estado previo del checkpoint → `ShieldedCheckpointClient.encryptAndUpdate(cumulativeSnap, cursor, keypair, signer)`. Soportar los 3 tokens (FLOW, mUSDC con approve previo, MockFT via FCL).

**Punto crítico:** El WrapWithSnapshot event contiene SOLO el estado marginal del wrap en curso. El checkpoint acumulado es `currentCheckpoint.balance + marginal.balance`, `currentCheckpoint.blinding + marginal.blinding`. Error en v0.7: sobreescribía con el marginal en lugar de acumular. Ver `test-accumulation-recovery.cjs` steps 3-5.

---

### 2.3 /send

**Referencia canónica:** `scripts/04-send-tip.cjs`

**Intento v0.8:**
1. Leer estado desde `ShieldedCheckpointClient.readAndDecrypt()` (no localStorage)
2. Verificar `getMemoKey(recipient)` ≠ null
3. `adapter.shieldedTransfer({ recipient, amount, memo, currentBalance, currentBlinding }, signer)`
4. `cpClient.update(sendResult.checkpointPayload!, 0n, signer)`
5. `memo-mirror.ts.saveSentMemo` para display sender-side

**Nota:** En v0.8, `memo` va en `SendParams.memo?: string` y el adapter lo cifra como parte del `NoteContent` (ECIES). No hay ruta separada `/api/memo/encrypt`.

---

### 2.4 /claim (unwrap)

**Referencia canónica:** `scripts/07-unwrap.cjs`

**Intento v0.8:**
1. `ShieldedCheckpointClient.readAndDecrypt()` para estado actual
2. `adapter.unwrap({ claimedAmount, recipient, currentBalance, currentBlinding }, signer)`
3. Parsear evento residual del receipt del unwrap → `decryptSnapshot` → `cpClient.update()`

**Nota del script:** `UnwrapResult` NO retorna `checkpointPayload` — hay que parsear el evento.

---

### 2.5 /tips (received + sent)

**Referencia canónica:** `scripts/05-tips-received.cjs` + `scripts/06-tips-sent.cjs`

**Received:**
1. `ShieldedInboxClient.count(evmAddr)` → badge "N notas pendientes"
2. Modo peek: `inboxClient.peekAll(evmAddr)` → decrypt manual
3. Modo drain: `inboxClient.drainAndDecrypt(signer, memoPrivKey)` → acumular notas + actualizar checkpoint
4. Correlación con PrivateTip metadata: query FCL `get_tips_by_recipient.cdc`

**Disambiguación multi-token por `note.depositor`:**
- `0xA64340C1d356835A2450306Ffd290Ed52c001Ad3` → FLOW
- `0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d` → mUSDC

**Sent:**
- Query FCL `get_tips_by_sender.cdc` → `TipMetadata{id, recipient, tokenSymbol, timestamp}`
- `ShieldedCheckpointClient.readAndDecrypt()` → saldo residual actual
- Memo: `memo-mirror.findSentMemo(sender, recipient, onChainTimestampSec)`

---

### 2.6 /portfolio

**Referencia canónica:** `scripts/02-portfolio.cjs`

**Intento v0.8:**
- `ShieldedCheckpointClient.readAndDecrypt()` → `SnapshotContent` (canónico)
- `ShieldedCheckpointClient.metadata(addr)` → `{version, lastUpdatedBlock, lastConsumedNoteIndex}`
- `ShieldedInboxClient.count(addr)` → mostrar `RecoveryBanner` si > 0
- `adapter.getCommitment(addr)` para cada token
- `adapter.getBalance(addr)` para cada token

**RecoveryBanner:** Si `inboxPendingCount > 0`: "Tienes N nota(s) en tu inbox sin procesar. [Drain inbox]"
**BatchClaim CTA:** Si `inboxPendingCount > 5` o `sumBlindings >= SUBORDER`: "Consolida tu estado shielded. [Batch Claim]"

**Flujo Batch Claim desde portfolio:**
1. `ShieldedInboxClient.drainAndDecrypt()` → notas `{amount, blinding}[]`
2. Calcular `sumBlindings % SUBORDER`
3. POST a `/api/proof/batch-claim` con `{oldBalance, oldBlinding, newBlinding, notesToConsume}`
4. `BatchClaimClient.claimBatch(publicInputs, proof)`
5. `cpClient.update(encryptedNewState, drained.length, signer)`

---

### 2.7 /faucet

Idéntico en lógica. Cambios:
- Actualizar `ADDRESSES.mockUSDC` → `0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524`
- Deployer Cadence → `0x4b6bc58bc8bf5dcc`
- `ft-setup.ts` — verificar address de MockFT receiver

---

### 2.8 /learn

Reescribir narrativa para cubrir Inbox-based delivery, Checkpoint como fuente de verdad, BatchClaim, 3-step onboarding. Referencia: `10-learn.cjs`.

---

## Section 3 — Lib rewrite

### `web/lib/recovery.ts` → DELETE COMPLETO
Llama `adapter.latestSnapshot()` que no existe en v0.8. `scanIncomingNotes` es lo que `ShieldedInboxClient.drainAndDecrypt()` formaliza.

### `web/lib/tip-actions.ts` → REWRITE PROFUNDO

**Eliminar:**
- Import `orchestrateShieldedTransferWithPrebuiltProof`
- `TX_SMART_SETUP` inline Cadence string
- `smartSetupAccount()` function
- Usos de `latestSnapshot`, `scanIncomingNotes`
- `PRIVATE_TIP_CADENCE = "0xb9ac529c14a4c5a1"` (v0.7 frozen)

**Reescribir:**
- `activateAccount()` → 3-step: derive keypair + publishMemoKey + `cadenceTx.installInboxAndCheckpoint()`
- `wrapToken()` → `adapter.wrap()` + parse `WrapWithSnapshot` + accumulate + `cpClient.encryptAndUpdate()`
- `sendTip()` → `adapter.shieldedTransfer()` + `cpClient.update(sendResult.checkpointPayload)`
- `unwrapToken()` → `adapter.unwrap()` + parse residual event + `cpClient.update()`
- `getShieldedState()` → `cpClient.readAndDecrypt()` (reemplaza todo scan de eventos)
- `drainInbox()` → `inboxClient.drainAndDecrypt()` + checkpoint update con cursor

**Mantener:** Helpers de units, `getCoaEvmAddress()`, `hasCOA()`, `getRecipientMemoPubkey()` (via `adapter.getMemoKey()`).

### `web/lib/memo-key-derive.ts` → KEEP con ajuste menor
Verificar que el mensaje de firma coincide con `MEMO_KEY_CONTEXT` del SDK.

### `web/lib/memo-key-session.ts` → KEEP sin cambios

### `web/lib/memo-mirror.ts` → PARTIAL REWRITE

**Mantener:**
- `saveSentMemo`, `findSentMemo` — sender sigue sin poder descifrar nota del receptor

**Eliminar:**
- `ingestTipIfNew()` — reemplazado por `drainAndDecrypt`
- `cacheDecryptedMemo()` / `getCachedDecryptedMemo()` — keyed por tipID inexistente en v0.8
- `loadIngestedSet()` / `saveIngestedSet()` — depende de ingestTipIfNew

### `web/lib/store.ts` → REWRITE DEL SCHEMA

**Nuevo schema:**
```typescript
export interface ShieldedTokenState {
  balanceRaw: string;
  blinding: string;
  checkpointVersion: string;
  lastUpdatedBlock: string;
  inboxPendingCount: number;
}
```

**Eliminar:** `loadShieldedState`, `saveShieldedState`, `clearShieldedStateForAddr`, `loadAllShieldedStates`, `sweepStaleShieldedCache`, `proxyFingerprint`, `shieldedKey`. Estado vive en memoria (Zustand) + rehidrata desde checkpoint on-chain.

### `web/lib/tokens.ts` → ADDRESS UPDATE ONLY

### `web/lib/ft-setup.ts` → REWRITE PARCIAL
Eliminar registry installation (ahora via `installInboxAndCheckpoint`). Mantener `checkReceiverCapability` + `setupVaultTx` (actualizar addresses al v0.8).

### `web/lib/fcl-config.ts` + `web/flow.json` → UPDATE ALIASES
```json
"PrivateTip": { "aliases": { "testnet": "4b6bc58bc8bf5dcc" } }
"JanusFlow": { "aliases": { "testnet": "4b6bc58bc8bf5dcc" } }
```

### `web/lib/utils.ts` → KEEP

---

## Section 4 — API routes rewrite

| Route | Action | Notes |
|---|---|---|
| `/api/faucet` | UPDATE addresses | Idéntico en lógica |
| `/api/keypair/generate` | KEEP | |
| `/api/memokey/derive` | KEEP | Verificar `MEMO_KEY_CONTEXT` |
| `/api/memo/encrypt` | **DELETE** | memo va en `SendParams.memo` |
| `/api/memo/decrypt` | **DELETE** | `drainAndDecrypt` retorna `NoteContent.memo` |
| `/api/note/encrypt` | **DELETE** | `shieldedTransfer` cifra internamente |
| `/api/note/decrypt` | **DELETE** | `drainAndDecrypt` |
| `/api/proof/wrap` | REWRITE | Verificar artifact paths en SDK 0.8.1 |
| `/api/proof/shielded-transfer` | REWRITE | ABI v0.8 6-arg, sin snapshot en calldata |
| `/api/proof/unwrap` | REWRITE | Agregar residual event al response |
| `/api/proof/commit` | **DELETE** | PENDING sin caller |
| `/api/proof/decrypt` | **DELETE** | HISTORICAL alias |
| `/api/proof/encrypt` | **DELETE** | HISTORICAL alias |
| `/api/proof/batch-claim` | **NEW** | ConfidentialClaimBatch proof, zkey 151MB server-side |
| `/api/snapshot/encrypt` → `/api/checkpoint/encrypt` | RENAME + simplify | Posiblemente eliminar (puede correr client-side) |

---

## Section 5 — Components

| Componente | Decisión | Notas |
|---|---|---|
| `ConnectWallet.tsx` | KEEP | |
| `TokenSelector.tsx` | KEEP — update token list | |
| `MainnetCountdown.tsx` | KEEP | |
| `animations/*` | KEEP | Conceptos sin cambios; revisar `ShieldedNoteLifecycle` para incluir inbox step |
| `ui/*` | KEEP | shadcn primitives |

**Componentes nuevos:**
- **`RecoveryBanner`** — "N nota(s) sin procesar. [Drain]" o "Estado recuperado del checkpoint on-chain (block X)"
- **`BatchClaimCTA`** — Card cuando inbox > 5 ó sumBlindings >= threshold
- **`CheckpointStatus`** — Chip/badge versión + bloque

---

## Section 6 — New views/flows que no existían en v0.7

### 6.1 Cross-session recovery via Checkpoint
**Dónde:** `/portfolio` primer mount + banner global. Recovery instantáneo desde on-chain, sin event scanning.

### 6.2 Inbox-based deposit (recipient no necesita estar online)
**Dónde:** `/tips` Received. Inbox acepta depósito atómicamente; recipient drena cuando quiera.

### 6.3 Batch claim ("re-blinding")
**Dónde:** `/portfolio` `BatchClaimCTA`. Suma de blindings puede exceder `SUBORDER` → `shieldedTransfer` falla silenciosamente con RangeError. Guía: drain inbox → server-side proof (60-90s) → `claimBatch()` → blinding fresco.

### 6.4 Sender-side snapshot (WrapWithSnapshot event)
**Dónde:** `/wrap` step post-confirmación. Auto-update checkpoint on-chain. v0.7 perdía estado en localStorage; v0.8 es permanente.

---

## Section 7 — DELETE list (legacy paths)

### Del INVENTORY-REPORT.md (ya clasificados)

```
.tmp_smoke_script.cdc
DEMO-READINESS-v0.2.1.md
web/e2e/smoke-results.json
scripts/test-cadence-wrap-unwrap-results.json
scripts/test-full-private-tip-cycle-results.json
scripts/test-multi-sender-results.json
scripts/test-router-claim-results.json
scripts/test_evm_import.cdc
scripts/v03-smoke-results.json
scripts/v04-smoke-full-results.json
scripts/v0_5_2-reset-txs.json
scripts/v0_5_2-smoke-results.json

# Tarballs legacy:
web/claucondor-sdk-0.7.5.tgz   ← reemplazado por 0.8.1-alpha.2
web/claucondor-sdk-0.6.6.tgz
web/claucondor-sdk-0.6.7.tgz
web/claucondor-sdk-0.7.2.tgz
web/openjanus-commitment-0.1.0.tgz

# Cadence contracts v0.7 (no editar, no referenciar):
cadence/contracts/PrivateTip.cdc     ← deploy OLD (0xb9ac529c14a4c5a1)
cadence/contracts/IPrivateTipImpl.cdc
cadence/contracts/PrivateTipImpl.cdc
```

### Adicionales invalidados por v0.8

```
# API routes:
web/app/api/memo/encrypt/route.ts
web/app/api/memo/decrypt/route.ts
web/app/api/note/encrypt/route.ts
web/app/api/note/decrypt/route.ts
web/app/api/proof/commit/route.ts
web/app/api/proof/decrypt/route.ts
web/app/api/proof/encrypt/route.ts

# Lib files:
web/lib/recovery.ts

# Funciones dentro de archivos:
web/lib/memo-mirror.ts:ingestTipIfNew, cacheDecryptedMemo, getCachedDecryptedMemo, loadIngestedSet, saveIngestedSet
web/lib/store.ts:loadShieldedState, saveShieldedState, clearShieldedStateForAddr, loadAllShieldedStates, sweepStaleShieldedCache, proxyFingerprint, shieldedKey
web/lib/tip-actions.ts:TX_SMART_SETUP, smartSetupAccount, orchestrateShieldedTransferWithPrebuiltProof import
web/lib/ft-setup.ts:checkJanusFTRegistryState, buildInstallJanusFTRegistryTx, signInstallJanusFTRegistryTx

# Componentes HISTORICAL:
web/components/BalanceDisplay.tsx
web/components/FlowProviderWrapper.tsx
web/components/PrivacyDisclosure.tsx
web/components/RecipientPubkeyDisplay.tsx
web/components/TestnetBanner.tsx
web/components/TipForm.tsx
```

---

## Section 8 — Open questions para operator decision

1. **EVM signer en el front web** ⚠️ BLOQUEANTE para Phase 1: Los scripts CLI usan `makeWallet(evmKey)` con raw private key. En el web app, el usuario controla el COA vía Cadence wallet. ¿El front ejecuta EVM txs vía (a) `window.ethereum` / MetaMask + ethers `BrowserProvider`, (b) `evm.run()` wrapped en Cadence tx FCL, o (c) exporta la private key del COA? (a)(b) son seguras; (c) inadmisible. El SDK adapter acepta `EVMSigner = ethers.Wallet`.

2. **Drain mode por defecto en /tips:** ¿Auto-drain al entrar (consume gas sin aviso) o botón explícito?

3. **BatchClaim: auto-prompt o siempre manual:** Threshold N para auto-prompt?

4. **Memo schema en v0.8:** ¿PrivateTip necesita campos app-specific (tipID, tag) más allá del `memo` básico?

5. **Checkpoint update post-unwrap:** ¿Parsear evento del receipt del unwrap o forzar al usuario a una operación adicional?

6. **Atomic shieldedTransfer + checkpoint:** ¿Usar `combinedShieldedTransferWithCheckpoint` (FCL Cadence wallet) o path 2-txs separadas?

---

## Section 9 — Phased execution proposal

**Phase 1 — Scaffolding lib/ y routes** (8 commits)
1. Install `@claucondor/sdk@0.8.1-alpha.2` + package.json + lock
2. `web/flow.json` aliases → `0x4b6bc58bc8bf5dcc`
3. `fcl-config.ts` + `tokens.ts` address check
4. `store.ts` schema v0.8 (eliminar localStorage helpers)
5. `memo-mirror.ts` eliminar ingestTipIfNew + cache por tipID
6. `tip-actions.ts` core rewrite (activate, wrap, send, unwrap)
7. `ft-setup.ts` addresses + eliminar JanusFT registry legacy
8. DELETE `recovery.ts` + routes memo/note/commit/legacy

**Phase 2 — API routes** (5 commits)
9. Rewrite `/api/proof/wrap`, `/shielded-transfer`, `/unwrap`
10. NEW `/api/proof/batch-claim`
11. Rewrite `/api/memokey/derive` + DELETE `/api/memo/*`, `/api/note/*`
12. UPDATE `/api/faucet` addresses
13. `/api/checkpoint/encrypt` (renombrado de snapshot/encrypt)

**Phase 3 — /status onboarding** (4 commits)
14. Componentes `CheckpointStatus`, `RecoveryBanner`
15. `status/page.tsx` 3-step
16. `client-layout.tsx` RecoveryBanner global
17. Test E2E onboarding

**Phase 4 — /wrap + /portfolio** (4 commits)
18. `wrap/page.tsx` — WrapWithSnapshot parsing + accumulation
19. `portfolio/page.tsx` — checkpoint-based + BatchClaimCTA
20. `BatchClaimCTA` componente completo
21. `ShieldedNoteLifecycle.tsx` animación update

**Phase 5 — /send + /tips** (4 commits)
22. `send/page.tsx` checkpoint read + send + checkpoint write
23. `tips/page.tsx` Received: drainAndDecrypt
24. `tips/page.tsx` Sent: PrivateTip query + memo-mirror + residual
25. Memo-mirror read integration

**Phase 6 — /claim + /faucet + /learn** (4 commits)
26. `claim/page.tsx` unwrap + event parse + checkpoint update
27. `faucet/page.tsx` + ft-setup v0.8 addresses
28. `learn/page.tsx` contenido v0.8
29. Circuit artifacts en `public/circuits/` si difieren

**Phase 7 — Pre-deploy preflight** (3 commits)
30. `next.config.ts` serverExternalPackages 0.8.1
31. Build local + type fixes + BigInt serialization
32. Vercel preview + smoke manual full cycle

**Dependencias:** P2 ⇐ P1; P3-P6 ⇐ P1+P2; P7 ⇐ all; P4 BatchClaim ⇐ P2 commit 10.

---

## Methodology

Plan derivado de: `scripts/01-10-*.cjs` + `scripts/test-accumulation-recovery.cjs` + `scripts/test-batch-claim.cjs` (referencia canónica v0.8), surface SDK 0.8.1-alpha.2 (`src/index.ts` + module index files), `INVENTORY-REPORT.md` (clasificación v0.7 invalidada donde aplica).

Decisiones bajo directiva: **sin migración, sin legacy, rewrite limpio para maximizar uso del SDK**.

---

## Top 5 findings críticos

1. **`recovery.ts` y `ingestTipIfNew` son código muerto total.** `adapter.latestSnapshot()` no existe en v0.8. Eliminación sin pérdida funcional.

2. **Las 4 rutas `/api/memo/*` y `/api/note/*` se eliminan completas.** En v0.8 el memo va en `SendParams.memo`, sale en `NoteContent.memo` post-drainAndDecrypt. SDK maneja ECIES interno.

3. **Wrap multi-token ACUMULA balance/blinding — no sobreescribe.** v0.7 sobreescribía con marginal. Patrón correcto: `currentCheckpoint.balance += marginal.balance`, idem blinding.

4. **`/api/proof/batch-claim` es ruta nueva crítica.** Sin ella el BatchClaim flow es imposible desde el front (zkey 151MB requiere Node.js).

5. **EVMSigner construction es bloqueante para Phase 1.** Scripts usan raw private keys. Web app necesita decidir: `window.ethereum` BrowserProvider vs `evm.run()` wrapped en Cadence FCL.
