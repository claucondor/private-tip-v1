# private-tip-v1 inventory (2026-06-08)

Auditor: automated read-only scan.
Branch: master @ 798ad7d
SDK en producción: claucondor-sdk-0.7.5.tgz (deploy fjw6oc1ta)
Contrato PrivateTip: 0xb9ac529c14a4c5a1

---

## Summary

| Categoría | Archivos |
|-----------|----------|
| Total tracked (git ls-files) | 160 |
| Untracked no-gitignored | 2 |
| **Scope total** | **162** |
| PRODUCTION (queda en main) | 79 |
| PENDING (feature branch) | 4 |
| HISTORICAL (→ `_archive/`) | 65 |
| DELETE | 14 |

Notas del scope:
- `.opencode/`, `imports/`, `emulator-account.pkey`, `DEMO-READINESS-v0.3.md`, `ARCHITECTURE-ANALYSIS.md`, `.tmp_test_script.cdc` están gitignoreados — NO están en git, no aplica acción.
- `web/tsconfig.tsbuildinfo` y `web/next-env.d.ts` son artefactos de build gitignoreados — idem.
- `web/.vercel/` está gitignoreado (por `web/.gitignore`). Nota: Vercel recomienda commitear `project.json` para CI deploys; actualmente no está en git.

---

## Detail per directory

### web/app/ (páginas)

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| layout.tsx | PRODUCTION | Root layout Next.js, entry point |
| client-layout.tsx | PRODUCTION | Nav, FlowProvider, banners de recovery/MemoKey |
| globals.css | PRODUCTION | Estilos globales Tailwind |
| icon.svg | PRODUCTION | Favicon |
| opengraph-image.tsx | PRODUCTION | Meta OG para redes |
| twitter-image.tsx | PRODUCTION | Meta Twitter card |
| page.tsx | PRODUCTION | Landing / home page |
| wrap/page.tsx | PRODUCTION | Flujo wrap (deposit shielded) |
| send/page.tsx | PRODUCTION | Flujo send shielded tip |
| claim/page.tsx | PRODUCTION | Flujo unwrap / withdraw |
| tips/page.tsx | PRODUCTION | Historial sent/received con decrypt de memos |
| portfolio/page.tsx | PRODUCTION | Vista multi-token de balances shielded |
| faucet/page.tsx | PRODUCTION | Testnet faucet (FLOW + mUSDC + MockFT) |
| status/page.tsx | PRODUCTION | Setup COA + MemoKey activation |
| learn/page.tsx | PRODUCTION | Educational / how-it-works |

### web/app/api/ (API routes)

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| faucet/route.ts | PRODUCTION | Faucet endpoint (llamado desde /faucet page) |
| keypair/generate/route.ts | PRODUCTION | Genera BabyJub keypair (server-safe) |
| memo/decrypt/route.ts | PRODUCTION | Descifra memos (llamado desde tips page) |
| memo/encrypt/route.ts | PRODUCTION | Cifra memos (llamado desde send page) |
| memokey/derive/route.ts | PRODUCTION | Deriva MemoKey desde sig de wallet |
| note/decrypt/route.ts | PRODUCTION | Descifra ShieldedNote — ruta restaurada en HEAD (fix fort25ks9) |
| note/encrypt/route.ts | PRODUCTION | Cifra ShieldedNote |
| proof/shielded-transfer/route.ts | PRODUCTION | Genera prueba Groth16 para transfer |
| proof/unwrap/route.ts | PRODUCTION | Genera ambas pruebas para unwrap |
| proof/wrap/route.ts | PRODUCTION | Genera prueba AmountDisclose para wrap |
| **proof/commit/route.ts** | **PENDING** | Route deployada pero sin caller activo en ninguna página; escrita para validación de recovery (computeCommitment sin ZK). Útil para completar el flujo de validación local en portfolio/claim. |
| proof/decrypt/route.ts | HISTORICAL | El propio comentario dice "legacy alias — canonical name is /api/proof/shielded-transfer". No es llamada por ninguna página actual. |
| proof/encrypt/route.ts | HISTORICAL | Idem: "legacy alias — canonical name is /api/proof/wrap". No es llamada. |
| **snapshot/encrypt/route.ts** | **PENDING** | UNTRACKED (nuevo hoy). Código funcional que envuelve SDK.encryptSnapshot. tip-actions.ts expone encryptSenderSnapshot() que llama esta ruta, pero esa función no es llamada por ninguna página actualmente. Completar wiring o revertir. |

### web/lib/

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| fcl-config.ts | PRODUCTION | Configura FCL + aliases desde flow.json |
| ft-setup.ts | PRODUCTION | Importado por faucet/page.tsx (check/install JanusFT registry) |
| memo-key-derive.ts | PRODUCTION | Importado por tip-actions.ts |
| memo-key-session.ts | PRODUCTION | Importado por tip-actions.ts, client-layout.tsx |
| memo-mirror.ts | PRODUCTION | Importado por tips/page.tsx (cache memos sent/received) |
| recovery.ts | PRODUCTION* | Importado por client-layout.tsx y portfolio/page.tsx. **ATENCIÓN**: la versión en disco tiene cambios sin commit (modified) que agregan `scanIncomingNotes` — hotfix experimental de hoy. Base PRODUCTION, cambios pendientes de decisión (ver sección Uncommitted). |
| store.ts | PRODUCTION | Zustand store + localStorage shielded state helpers |
| tip-actions.ts | PRODUCTION | Capa de acción principal sobre SDK — wrap/send/unwrap/record |
| tokens.ts | PRODUCTION | Registry de tokens para UI (FLOW/mUSDC/MockFT) |
| utils.ts | PRODUCTION | cn() helper (shadcn) |

### web/components/

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| ConnectWallet.tsx | PRODUCTION | Importado por client-layout.tsx |
| TokenSelector.tsx | PRODUCTION | Importado por wrap, send, claim, faucet, portfolio pages |
| MainnetCountdown.tsx | PRODUCTION | Importado por client-layout.tsx (banner top) |
| animations/PedersenCommitFormation.tsx | PRODUCTION | Importado por wrap/page.tsx y claim/page.tsx |
| animations/ShieldedNoteEncrypt.tsx | PRODUCTION | Importado por send/page.tsx |
| animations/ShieldedNoteLifecycle.tsx | PRODUCTION | Importado por learn/page.tsx |
| ui/button.tsx | PRODUCTION | shadcn — usado en múltiples páginas |
| ui/card.tsx | PRODUCTION | shadcn |
| ui/dialog.tsx | PRODUCTION | shadcn |
| ui/input.tsx | PRODUCTION | shadcn |
| ui/label.tsx | PRODUCTION | shadcn |
| ui/separator.tsx | PRODUCTION | shadcn |
| ui/sonner.tsx | PRODUCTION | shadcn (toast) |
| ui/textarea.tsx | PRODUCTION | shadcn |
| BalanceDisplay.tsx | HISTORICAL | No hay ningún import de este componente en el repo. Superado por lógica inline en las páginas. |
| FlowProviderWrapper.tsx | HISTORICAL | Superado por `<FlowProvider>` directo en client-layout.tsx con @onflow/react-sdk. |
| PrivacyDisclosure.tsx | HISTORICAL | Sin imports. Nunca wired. |
| RecipientPubkeyDisplay.tsx | HISTORICAL | Sin imports. Nunca wired. |
| TestnetBanner.tsx | HISTORICAL | Superado por `<MainnetCountdown>` que reemplaza el banner con countdown + faucet CTA. |
| TipForm.tsx | HISTORICAL | Sin imports. Flujo de send se implementó directamente en send/page.tsx. |

### web/ (config y tooling)

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| next.config.ts | PRODUCTION | Next.js build config (serverExternalPackages para SDK) |
| tsconfig.json | PRODUCTION | TypeScript config |
| package.json | PRODUCTION | Dependencias del app (referencia SDK 0.7.5 y openjanus-commitment) |
| package-lock.json | PRODUCTION | Lock file |
| bun.lock | PRODUCTION | Lock file (Bun) |
| postcss.config.mjs | PRODUCTION | Tailwind v4 |
| eslint.config.mjs | PRODUCTION | ESLint |
| components.json | PRODUCTION | shadcn config |
| flow.json | PRODUCTION | Aliases de contratos Cadence (JanusFlow, PrivateTip, EVM) |
| .gitignore | PRODUCTION | Gitignore del subdir web/ |
| fcl.d.ts | PRODUCTION | Type declarations para @onflow/fcl |
| AGENTS.md | PRODUCTION | Instrucciones para agentes que trabajan en este subdir |
| AUDIT.md | PRODUCTION | Registro de auditoría v0.7 |
| CLAUDE.md | PRODUCTION | Instrucciones tooling |
| README.md | PRODUCTION | Documentación del web app |

### web/public/circuits/ (artefactos ZK — CRÍTICOS)

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| build/decrypt_open.wasm | PRODUCTION | Leído por /api/proof/shielded-transfer y /api/proof/unwrap |
| build/encrypt_consistency.wasm | PRODUCTION | Leído por /api/proof/wrap y /api/proof/unwrap |
| setup/decrypt_open_final.zkey | PRODUCTION | Trusted setup — requerido para snarkjs fullProve |
| setup/decrypt_open_vkey.json | PRODUCTION | Verification key |
| setup/encrypt_consistency_final.zkey | PRODUCTION | Idem para AmountDisclose circuit |
| setup/encrypt_consistency_vkey.json | PRODUCTION | Idem |

### web/public/ (assets estáticos de Next.js starter)

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| file.svg | HISTORICAL | Next.js create-app placeholder. No usado en el UI de PrivateTip. |
| globe.svg | HISTORICAL | Idem |
| next.svg | HISTORICAL | Idem |
| vercel.svg | HISTORICAL | Idem |
| window.svg | HISTORICAL | Idem |

### Tarballs (web/)

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| claucondor-sdk-0.7.5.tgz | PRODUCTION | SDK activo — referenciado en package.json como `file:claucondor-sdk-0.7.5.tgz` |
| openjanus-commitment-0.1.0.tgz | PRODUCTION | `@openjanus/commitment` en package.json — usado por /api/proof/commit y circuit helpers |
| claucondor-sdk-0.6.6.tgz | HISTORICAL | SDK viejo. Conservar en `_archive/sdk-tarballs/` en caso de bisect futuro. |
| claucondor-sdk-0.6.7.tgz | HISTORICAL | Idem |
| claucondor-sdk-0.7.2.tgz | HISTORICAL | Idem |

### web/ scripts operacionales (fund-faucet)

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| fund-faucet.mjs | HISTORICAL | Script one-time: setup MockFT vault + mint + CrossVM fund. Ya ejecutado. Conservar como referencia de cómo re-fondear el faucet. |
| fund-faucet-evm.mjs | HISTORICAL | Idem — transfiere FLOW del COA al EOA para gas. |
| fund-faucet-task3.mjs | HISTORICAL | Idem — parte 3: COA deposit + mUSDC mint. |

### web/e2e/

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| smoke.test.ts | PENDING | Test E2E v0.7 completo (wrap→transfer→decrypt→unwrap, 3 tokens). No está en CI. Requiere env vars con pkeys. Mover a feature branch `feat/e2e-ci` o directorio `dev-tools/`. |
| smoke-results.json | DELETE | Resultados de una ejecución con todos los tokens en SKIP ("Alice has no MemoKey"). Dato sin valor. |

### cadence/contracts/

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| PrivateTip.cdc | PRODUCTION | Contrato principal desplegado en 0xb9ac529c14a4c5a1. Source of truth local. |
| IPrivateTipImpl.cdc | PRODUCTION | Interfaz del impl pattern — también en 0xb9ac529c14a4c5a1. |
| PrivateTipImpl.cdc | PRODUCTION | Impl stateless — también en 0xb9ac529c14a4c5a1. |

### cadence/scripts/

Ninguno de estos scripts es referenciado desde el web app. El app hace queries via SDK adapters o inline FCL scripts embebidos en tip-actions.ts.

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| get_memo_pubkey.cdc | HISTORICAL | Superado por SDK getMemoKey() y MemoKeyRegistry EVM. |
| get_shielded_tip.cdc | HISTORICAL | No usado en web. Era para indexing manual. |
| get_shielded_tips_by_recipient.cdc | HISTORICAL | Idem. |
| get_tip.cdc | HISTORICAL | Idem. |
| get_tips_by_recipient.cdc | HISTORICAL | Idem. |
| get_total_tip_count.cdc | HISTORICAL | Idem (web usa buildGetTipCountScript() inline en tip-actions.ts). |
| is_paused.cdc | HISTORICAL | Útil para ops. Mover a `_archive/cadence-scripts/`. |

### cadence/transactions/

Ninguno es referenciado desde el web app. Las transacciones de usuario (setup COA, send tip, wrap, unwrap) están embebidas inline en `tip-actions.ts` como template strings. Los admin tx están solo en este directorio.

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| admin_drain_legacy_vault.cdc | HISTORICAL | Tx administrativa de mantenimiento. Conservar en `_archive/cadence-txs/`. |
| admin_force_set_impl_version.cdc | HISTORICAL | Idem. |
| admin_pause.cdc | HISTORICAL | Idem — importante para emergencias, conservar accesible. |
| admin_upgrade.cdc | HISTORICAL | Idem. |
| jf_wrap.cdc | HISTORICAL | Superado por SDK wrapViaCoa() + inline Cadence en tip-actions.ts. |
| jf_wrap_from_coa.cdc | HISTORICAL | Idem. |
| jf_unwrap.cdc | HISTORICAL | Superado por SDK unwrapViaCoa(). |
| jf_unwrap_to_vault.cdc | HISTORICAL | Idem. |
| send_shielded_tip.cdc | HISTORICAL | Superado por combinedTx inline en tip-actions.ts sendShieldedAction(). |
| setup_account.cdc | HISTORICAL | Superado por TX_SMART_SETUP en tip-actions.ts. |
| setup_coa.cdc | HISTORICAL | Idem. |
| setup_memo_key.cdc | HISTORICAL | Idem. |

### scripts/ (root-level dev/test scripts)

Los scripts en esta carpeta son del proceso de desarrollo iterativo (v0.1-v0.5.2). Ninguno tiene utilidad directa para el sitio desplegado. Los `.mjs` que referencian el proxy viejo (0x025efe7e89acdb8F315C804BE7245F348AA9c538) son del era pre-v0.6 y son obsoletos.

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| ambient.d.ts | HISTORICAL | Type declarations para scripts TypeScript. No deploya. |
| check-commit.mjs | HISTORICAL | Referencia proxy viejo (0x025efe7e…). Debugging util. |
| check_bal.cdc | HISTORICAL | One-time FLOW balance check. |
| check_coa_bal.cdc | HISTORICAL | One-time COA balance check. |
| check_coa_bal.ts | HISTORICAL | Idem en TS. |
| check_coa_exists.js | HISTORICAL | Idem. |
| deposit_to_coa.cdc | HISTORICAL | Transacción one-time. |
| find-first-block-throttled.mjs | HISTORICAL | Utility para event scanning. Puede ser útil para futuros scripts de indexing. |
| find-first-block.mjs | HISTORICAL | Idem sin throttle. |
| fund_coa_eoa.cdc | HISTORICAL | One-time funding. |
| fund_coas.ts | HISTORICAL | Fondeo inicial de múltiples COAs. |
| fund_coas_v2.ts | HISTORICAL | Idem v2. |
| fund_specific_coa.cdc | HISTORICAL | One-time. |
| get_coa_address.cdc | HISTORICAL | Utility Cadence script. |
| query_coa_addr.cdc | HISTORICAL | Idem. |
| register_pubkey.cdc | HISTORICAL | Superado por TX_SMART_SETUP. |
| register_pubkey_v2.cdc | HISTORICAL | Idem. |
| smoke-test.ts | HISTORICAL | **v0.2.1 era** — referencia el viejo proxy UUPS (0x025efe7e…). Completamente obsoleto. |
| test-cadence-wrap-unwrap.mjs | HISTORICAL | Test v0.3 era Cadence wrap/unwrap. |
| test-cadence-wrap-unwrap-results.json | DELETE | Resultado de ejecución, sin valor. |
| test-full-private-tip-cycle.mjs | HISTORICAL | Test v0.3 era ciclo completo. |
| test-full-private-tip-cycle-results.json | DELETE | Resultado de ejecución. |
| test-multi-sender.mjs | HISTORICAL | Test multi-sender v0.3. |
| test-multi-sender-results.json | DELETE | Resultado. |
| test-router-claim.mjs | HISTORICAL | Test claim v0.2. |
| test-router-claim-results.json | DELETE | Resultado. |
| test_evm_import.cdc | DELETE | Una línea: `access(all) fun main(): UInt64 { return 42 }`. Archivo de sanity check. |
| v03-smoke.mjs | HISTORICAL | Smoke test v0.3. |
| v03-smoke-results.json | DELETE | Resultados. |
| v04-smoke-full.mjs | HISTORICAL | Smoke test v0.4 completo. |
| v04-smoke-full-results.json | DELETE | Resultados. |
| v0_5_2-recovery-smoke.mjs | HISTORICAL | Smoke test recovery v0.5.2. |
| v0_5_2-reset-txs.json | DELETE | TxIDs de resets de testnet — datos efímeros. |
| v0_5_2-smoke-results.json | DELETE | Resultados. |
| verify_ct.mjs | HISTORICAL | Referencia proxy viejo (0x025efe7e…). |

### Root-level (fuera de web/)

| Archivo | Veredicto | Razón |
|---------|-----------|-------|
| flow.json | PRODUCTION | Usado por Flow CLI para deploy/test de contratos Cadence. |
| README.md | PRODUCTION | Documentación del proyecto. |
| .gitignore | PRODUCTION | Gitignore root. |
| .cursorignore | PRODUCTION | Editor config. |
| package.json | HISTORICAL | Referencia `@openjanus/sdk` con path local `file:../../openjanus-sdk` — roto fuera de la máquina dev. Solo sirve para los scripts/ que ya son HISTORICAL. |
| package-lock.json | HISTORICAL | Lock del package.json raíz. |
| tsconfig.json | HISTORICAL | Config TS para scripts/ raíz. |
| DEMO-READINESS-v0.2.1.md | HISTORICAL | Checklist v0.2.1 comprometido en git por accidente (la regla `DEMO-READINESS*.md` del .gitignore existía pero no protege archivos ya commiteados). |
| .tmp_smoke_script.cdc | DELETE | Archivo temporal commiteado por accidente. Contiene un Cadence script de check de balance. |

---

## Uncommitted changes — triage

### web/lib/recovery.ts (modified, not staged)

El archivo base es PRODUCTION y está importado por `client-layout.tsx` y `portfolio/page.tsx`. Los cambios de hoy agregan un bloque `scanIncomingNotes` dentro de `recoverShieldedState`:

```
// HOT FIX: latestSnapshot only returns the most recent own-snapshot...
const incoming: any[] = await (adapter as any).scanIncomingNotes(addr);
```

**Decisión requerida:**
- Si `scanIncomingNotes` existe en el SDK 0.7.5 actual y la lógica es correcta → commit como fix
- Si `scanIncomingNotes` no existe en 0.7.5 → revert con `git checkout web/lib/recovery.ts`
- El try/catch interno hace que si el método no existe, silenciosamente caiga al snapshot-only (no rompe nada, pero tampoco suma incoming notes)

**Recomendación: verificar en la tarball si SDK 0.7.5 exporta `scanIncomingNotes` antes de commitear.**

### test-recipients.json (untracked)

Captura de estado de testnet del 2026-06-04 con addresses, memokeys, y snapshots de balances. Referencias a proxies v0.6.6 (JanusFlow 0x2f4b9b63…) que ya no son los proxies actuales v0.7.5 (JanusFlow 0x9A83732…). **DELETE** — dato obsoleto y con información sensible de alineación de privkeys de E2E.

### web/app/api/snapshot/encrypt/route.ts (untracked — PENDING)

Nueva ruta funcional que envuelve `encryptSnapshot` del SDK server-side. El código es correcto. Actualmente no está wired:
- `tip-actions.ts` exporta `encryptSenderSnapshot()` que llama esta ruta
- Pero `encryptSenderSnapshot()` no es llamada desde ninguna página
- La orquestación de snapshots ocurre dentro de `orchestrateShieldedTransferWithPrebuiltProof()` del SDK

**Opciones:**
1. Commitear como inicio del feature (si el plan es reemplazar la orquestación SDK por control manual del snapshot)
2. Reverter (si `orchestrateShieldedTransferWithPrebuiltProof` ya maneja snapshots correctamente)

---

## Action plan

| Acción | Archivos |
|--------|----------|
| Sin acción (quedan en main) | **79 PRODUCTION** |
| Commitear o revertir decision | 4 PENDING: `proof/commit/route.ts`, `snapshot/encrypt/route.ts`, `e2e/smoke.test.ts`, cambios en `recovery.ts` |
| `git rm` + mover a `_archive/private-tip-v1/` | **65 HISTORICAL** |
| `git rm` (no archive) | **14 DELETE** |

### Archivos DELETE concretos (en git, `git rm`)
```
.tmp_smoke_script.cdc
DEMO-READINESS-v0.2.1.md   # commiteado antes del gitignore pattern
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
```

### Archivos DELETE untracked (solo `rm`)
```
test-recipients.json
```

### Rama sugerida para PENDING files
`feat/proof-commit-recovery` — para `proof/commit/route.ts` y `snapshot/encrypt/route.ts` una vez que estén wired
`feat/e2e-ci` — para `web/e2e/smoke.test.ts` + eventual CI setup

### Estructura sugerida para `_archive/`
```
_archive/private-tip-v1/
├── cadence-scripts/          # cadence/scripts/*.cdc (7 files)
├── cadence-txs/              # cadence/transactions/*.cdc (9 files)
├── components-unused/        # BalanceDisplay, FlowProviderWrapper, etc. (6 files)
├── sdk-tarballs/             # claucondor-sdk-0.6.6/0.6.7/0.7.2.tgz (3 files)
├── fund-faucet-scripts/      # fund-faucet*.mjs (3 files)
├── api-routes-legacy/        # proof/decrypt, proof/encrypt route.ts (2 files)
├── public-starters/          # file.svg, globe.svg, etc. (5 files)
├── root-tooling/             # root package.json, tsconfig.json, package-lock.json, DEMO-READINESS-v0.2.1.md (4 files)
└── scripts/                  # todos los scripts/ (26 ejecutables) 
```

---

## Open questions para el operator

1. **`web/lib/recovery.ts` changes**: ¿Existe `scanIncomingNotes` en el SDK 0.7.5? Verificar con `tar -tzf web/claucondor-sdk-0.7.5.tgz | grep scanIncoming`. Si no existe, revertir. Si existe, es un fix real y merece un commit.

2. **`web/app/api/snapshot/encrypt/route.ts`**: ¿Es este el inicio de una feature de "manual snapshot encryption" para reemplazar la orquestación interna del SDK? Si no, revertir.

3. **`web/app/api/proof/commit/route.ts`**: ¿Hay planes de usarla en la UI de validación de recovery? Si no, mover a _archive o feature branch.

4. **Admin transactions** (`cadence/transactions/admin_*.cdc`): Antes de moverlas a `_archive/`, confirmar que el operator tiene copia accesible para operaciones de emergencia (pause, upgrade). Alternativa: moverlas a un repo privado de ops.

5. **`web/.vercel/project.json`**: Actualmente gitignoreado. Vercel recomienda committear este archivo para que CI/CD deploys funcionen sin `.vercel/` local. Decidir si agregar a git (requiere `git add -f`) o mantener gitignoreado con deploy manual.

6. **`.tmp_smoke_script.cdc`**: Commiteado accidentalmente. La regla `.gitignore` solo captura `.tmp_test_script.cdc` pero no `.tmp_smoke_script.cdc`. Agregar patrón `.tmp_*.cdc` al gitignore o solo eliminar el archivo.

7. **SDK tarballs viejos** (0.6.6, 0.6.7, 0.7.2): ¿Conservar en `_archive/sdk-tarballs/` para poder bisectar bugs históricos, o eliminar directamente? Son archivos binarios pesados en git history.

8. **`DEMO-READINESS-v0.2.1.md`**: Está en git aunque el gitignore dice `DEMO-READINESS*.md`. Fue commiteado antes de añadir el pattern. Para removerlo del repo sin borrarlo del filesystem: `git rm --cached DEMO-READINESS-v0.2.1.md`.
