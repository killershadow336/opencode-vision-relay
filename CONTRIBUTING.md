# Contributing / Desarrollo

Documentación para quien clona el repo, quiere tocar el plugin o publicar una
versión nueva. Para **usar** el plugin, mira el [`README.md`](README.md).

---

## Setup

```sh
git clone https://github.com/killershadow336/opencode-vision-relay.git
cd opencode-vision-relay
npm install
```

> `dist/` está en `.gitignore` — nunca se sube. Se genera al publicar (ver más abajo).

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` — solo chequea tipos |
| `npm test` | Vitest — suite completa (relay, providers, resize, live) |
| `npm run build` | `tsc -p tsconfig.build.json` → `dist/` (JS + `.d.ts`) |
| `npm pack --dry-run` | Previsualiza el tarball de publicación |
| `npm publish` | Publica en el registro (corre `prepack` antes) |

Con cualquier cambio de `.ts`: **`npm run build` antes de probar el plugin** en
OpenCode (apuntando a `dist/index.js` o a `index.ts` directamente).

## Arquitectura

```
index.ts      → entrypoint: registra hooks de contexto + aisdk.language
live.ts       → wrapper defensivo de streaming para modelos text-only AI SDK
                (en opencode actual nunca recibe imágenes; el hook de contexto
                hace el relay siempre)
relay.ts      → reemplaza media parts de tipo imagen por análisis de texto (hook context)
options.ts    → parseo/validación de opciones (resolveOptions)
providers.ts  → resuelve el proveedor activo (gemini/openai/personalizados) + transportOptions
openai.ts     → transporte genérico OpenAI-compatible (analyze/stream, retries, tiempo)
resize.ts     → downscale de PNG/JPEG (área-average) antes de enviar
images.ts     → helpers de data URIs / bytes
image-libs.d.ts → tipos para pngjs y jpeg-js
test/         → suites de Vitest por módulo
```

Flujo de una imagen: `index.ts` (hook context) → `relay.ts` → `resize.ts`
(opcional) → `providers.ts` → `openai.ts` → bloque `[IMAGE N ANALYSIS]` que
sustituye a la media part original. En modelos AI SDK pasa por `live.ts`.

## Añadir un proveedor

Los proveedores son **"openai" con defaults propios** (`type`, `baseUrl`/
`endpoint`, `model`, `apiKeyEnv`, `apiKeyFile`). Añadir uno nuevo es
configuración, no código:

1. En el `opencode.json` del usuario: `options.providers.<nombre> = { type:
   "openai", baseUrl/endpoint, model, ... }`.
2. `providers.ts` resuelve el nombre desde `options` con fallback y warning; no
   hay transporte específico que escribir porque `openai.ts` es genérico.

Solo se tocan `openai.ts`/`providers.ts` si quieres **otro tipo de transporte**
(no OpenAI-compatible).

## Añadir una opción

1. `options.ts`: campo nuevo (con su default) + parse en `resolveOptions`
   (num/str/bool/optStr según el tipo).
2. Propágalo donde aplique (`providers.ts`, `relay.ts`, `live.ts`, `openai.ts`).
3. Documenta en la tabla de opciones del `README.md`.

## Pruebas

Las suites están en `test/`. Añade casos para tu cambio y ejecuta `npm test`.
Prepárate para que `prepack` (clean → build → test) pase en cada publicación:
si no pasa, no se empaqueta.

## Publicar una versión

npm exige **versión nueva** para que el registro refleje cambios (README, etc.).

```sh
npm version patch    # o minor/major → bump, commit y tag vX.Y.Z
git push origin main --tags
npm publish          # interactivo: pide tu security key (2FA WebAuthn) del registro
```

- `prepack` corre `clean && build && test` antes de empaquetar (45+ casos).
- La publicación es **interactiva**: se hace desde tu terminal y es normal que
  npm te pida confirmar con tu security key/passkey (Bitwarden, Windows Hello,
  YubiKey…).
- Verifica al final: `npm view opencode2-vision-relay version`.

## Debugging

- `"options": { "debug": true }` → logs `[vision-relay]` en la salida de
  OpenCode (proveedor, modelo, nº de imágenes, aciertos de caché). Nunca
  imprime claves.
- Para problemas de carga del plugin, reinicia el servicio
  (`opencode2 service restart`) y revisa el log del servidor.

## Notas de mantenimiento

- El `pluginId` es `opencode.vision-relay`; `@opencode-ai/plugin` se mantiene
  clavado a la versión del CLI con la que se prueba (`0.0.0-next-17444`).
- Las claves solo se leen de `process.env` o del archivo de respaldo
  (`~/.config/opencode/*.key`); nunca hardcodear una key en el código ni en los
  tests.