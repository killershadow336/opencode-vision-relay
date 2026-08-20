# opencode2-vision-relay

[![npm version](https://img.shields.io/npm/v/opencode2-vision-relay)](https://www.npmjs.com/package/opencode2-vision-relay)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Plugin nativo de OpenCode V2 que da visión a modelos que solo aceptan texto.**

Pegas una imagen, el plugin la envía al **proveedor de visión** que elijas —
**Gemini** por defecto, o cualquier API compatible con OpenAI (OpenAI, Groq,
OpenRouter, Ollama, LM Studio…) — y le pasa al modelo principal una descripción
textual detallada antes de que llegue a la respuesta. Así **cualquier modelo
text-only** (sin importar cuál) puede "ver" la imagen. Si el modelo ya soporta
imágenes, el plugin no interviene.

```
Usuario adjunta imagen
        │
        ▼
OpenCode V2 (hook de contexto antes del dispatch)
        │
        ▼
Plugin detecta media part de tipo image
        │  (solo si el modelo activo NO soporta imágenes)
        ▼
Proveedor de visión (gemini · openai · proveedor personalizado)
        │
        ▼
[IMAGE 1 ANALYSIS] … [/IMAGE 1 ANALYSIS]
        │
        ▼
El modelo text-only recibe solo texto y responde
```

**Lo esencial:**
- ✅ **Multi-proveedor**: Gemini (por defecto), OpenAI-compatible genérico, o proveedores personalizados.
- ✅ **Auto-redimensionado** de capturas grandes → análisis en segundos en vez de minutos.
- ✅ **Solo actúa cuando hace falta**: si el modelo activo ya ve imágenes, el plugin se mantiene al margen (lo detecta de las capacidades del modelo en el catálogo de OpenCode).
- ✅ **Sin hacks**: no modifica OpenCode, no usa proxy externo, no toca la conversación guardada y nunca rompe la petición (los errores del proveedor se convierten en avisos en el chat).

---

## Requisitos

- OpenCode V2 (`opencode2`). Probado con `0.0.0-next-17444` — el paquete `@opencode-ai/plugin` debe coincidir con la versión de tu CLI.
- Node.js ≥ 20 (solo para resolver dependencias del plugin).
- Una API key del proveedor de visión elegido (Gemini tiene capa gratuita).

## Instalación

### Desde npm (recomendado)

```sh
npm install -g opencode2-vision-relay
```

Añade el paquete a tu `opencode.json` (global en `~/.config/opencode/opencode.json` o por proyecto):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode2-vision-relay"]
}
```

### Desde GitHub

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:killershadow336/opencode-vision-relay"]
}
```

### Desde una copia local (fork / desarrollo)

```sh
git clone https://github.com/killershadow336/opencode-vision-relay.git
cd opencode-vision-relay
npm install
npm run build      # genera dist/
```

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "./opencode-vision-relay/dist/index.js", "options": {} }
  ]
}
```

> En desarrollo también puedes apuntar a `index.ts` directamente (OpenCode carga
> TypeScript nativo); `dist/index.js` es el artefacto publicado.

**Verifica que cargó** (reinicia OpenCode antes):

```sh
opencode2 api get /api/plugin
```

Debe aparecer `opencode.vision-relay` en la lista.

---

## 🚀 Empezar con Gemini (5 minutos)

### 1 · Consigue la API key (gratis)

1. Entra a **https://aistudio.google.com/apikey** e inicia sesión con tu cuenta de Google.
2. Pulsa **Create API key** → elige un proyecto (o crea uno).
3. Copia la clave que empieza por **`AIza...`** y guárdala en un sitio seguro. **No la subas a ningún repo.**

### 2 · Configura la key

El plugin la busca en este orden: **variable de entorno** → **archivo de respaldo**. El archivo es el método estable: aunque el servicio de OpenCode se reinicie desde cualquier proceso (y aunque ese proceso no tenga tu variable), el plugin siempre encuentra la key.

**Método recomendado — archivo:**
```sh
mkdir -p ~/.config/opencode
printf '%s' 'AIza...tu-clave-real' > ~/.config/opencode/vision-relay.key
```

**Alternativa — variable de entorno:**
```sh
export GOOGLE_AI_STUDIO_API_KEY="AIza...tu-clave-real"
```

> En **Windows nativo** (PowerShell): `setx GOOGLE_AI_STUDIO_API_KEY "AIza..."`, y cierra/vuelve a abrir la terminal.

**Comprueba que la key funciona:**
```sh
curl -s "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_API_KEY" \
  -d '{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"di hola"}]}'
```
Si ves una respuesta con `"choices"`, la key es válida. ✅

> Opcional: otro modelo de Gemini → `export VISION_MODEL="gemini-3.6-flash"` (por defecto ya es ese).

### 3 · ¡A usarlo!

1. Abre `opencode2` y elige un modelo **sin visión** (text-only).
2. **Adjunta una imagen** (arrastra el archivo o pega una captura).
3. Pregunta, por ejemplo: *"¿Qué error aparece en esta captura?"*, *"Transcribe el texto de esta imagen"* o *"Explícame este diagrama"*.
4. El modelo recibe la descripción del proveedor y responde.

> Con modelos que **ya** ven imágenes (p. ej. `opencode/mimo-v2.5-free`) el plugin se calla y no interviene.

---

## Elegir proveedor (`provider`)

El plugin distingue dos familias nativas y permite proveedores personalizados:

| `provider` | Qué es | Key por defecto |
| --- | --- | --- |
| `"gemini"` (default) | Google AI Studio, endpoint OpenAI-compatible | `GOOGLE_AI_STUDIO_API_KEY` |
| `"openai"` | Cualquier API OpenAI-compatible (OpenAI, Groq, OpenRouter, Ollama…) | `OPENAI_API_KEY` |
| `<cualquier nombre>` | Entrada personalizada en `providers` | la que definas |

### Ejemplo 1 — Gemini (por defecto, sin config extra)

```jsonc
{
  "plugins": [
    { "package": "opencode2-vision-relay", "options": {} }
  ]
}
```

### Ejemplo 2 — OpenAI

```jsonc
{
  "plugins": [
    {
      "package": "opencode2-vision-relay",
      "options": {
        "provider": "openai",
        "model": "gpt-4o"   // opcional; por defecto gpt-4o
      }
    }
  ]
}
```

Key: `OPENAI_API_KEY` (env) o `~/.config/opencode/openai.key`.

### Ejemplo 3 — Ollama (local, sin API key)

```jsonc
{
  "plugins": [
    {
      "package": "opencode2-vision-relay",
      "options": {
        "provider": "ollama",
        "providers": {
          "ollama": {
            "type": "openai",
            "baseUrl": "http://localhost:11434/v1",
            "model": "llava"
          }
        }
      }
    }
  ]
}
```

### Ejemplo 4 — Groq (baseUrl + key propia)

```jsonc
{
  "plugins": [
    {
      "package": "opencode2-vision-relay",
      "options": {
        "provider": "groq",
        "providers": {
          "groq": {
            "type": "openai",
            "baseUrl": "https://api.groq.com/openai",
            "model": "llama-3.2-90b-vision-preview",
            "apiKeyEnv": "GROQ_API_KEY"
          }
        }
      }
    }
  ]
}
```

> Un proveedor personalizado es **"openai" con defaults propios**: pon
> `type: "openai"`, un `baseUrl` (recibirá `/chat/completions` al final) o un
> `endpoint` completo, el `model` que quieras y opcionalmente dónde leer la key.
> También puedes sobrescribir un built-in: `providers: { gemini: { model: "…" } }`.

---

## Variables de entorno y archivo de key

El plugin resuelve la API key **en cada envío**: env var → archivo de respaldo.
El archivo hace el sistema estable ante reinicios del servicio.

**Gemini** (default): `GOOGLE_AI_STUDIO_API_KEY` o `~/.config/opencode/vision-relay.key`
**OpenAI genérico**: `OPENAI_API_KEY` o `~/.config/opencode/openai.key`
**Proveedores personalizados**: la `apiKeyEnv`/`apiKeyFile` que definas.

El plugin nunca imprime las claves en logs.

---

## Configuración (opciones)

| Opción | Default | Descripción |
| --- | --- | --- |
| `enabled` | `true` | Apaga el plugin por completo. |
| `provider` | `"gemini"` | Proveedor activo: `"gemini"`, `"openai"` o un nombre de `providers`. |
| `providers` | `{}` | Mapa nombre → config (`type`, `model`, `endpoint`/`baseUrl`, `apiKeyEnv`, `apiKeyFile`, `maxTokens`, `visionPrompt`). |
| `model` | por proveedor | Sobrescribe el modelo del proveedor activo (`gemini-3.6-flash` / `gpt-4o`). |
| `endpoint` | por proveedor | Sobrescribe el endpoint OpenAI-compatible completo. |
| `apiKeyEnv` | por proveedor | Sobrescribe la variable de entorno de la key. |
| `apiKeyFile` | por proveedor | Sobrescribe el archivo de respaldo de la key. |
| `timeoutMs` | `190000` | Timeout por imagen (mín. 1000). Solo acota el análisis de cada imagen; el stream del modelo no se corta por este valor. |
| `maxTokens` | `2048` | `max_tokens` de la respuesta (mín. 64). |
| `maxImagesPerMessage` | `10` | Máx. imágenes analizadas por mensaje; el resto se marca como omitidas (mín. 1). |
| `maxImageBytes` | `15728640` (15 MiB) | Máx. bytes decodificados por imagen; por encima se omite con aviso (mín. 1024). |
| `maxResizeWidth` | `2000` | Máx. ancho (px) que se envía al proveedor; las capturas PNG/JPEG más anchas se **reducen antes** de analizar (baja muchísimo latencia/coste). `0` desactiva el redimensionado. |
| `skipModels` | `[]` | IDs de modelo que nunca se procesan (ya ven imágenes). |
| `alwaysProcessModels` | `[]` | IDs de modelo que siempre se procesan, aunque el catálogo diga que ven imágenes. |
| `processUnknownModels` | `true` | Si el modelo no aparece en el catálogo, se procesa igualmente. |
| `visionPrompt` | prompt interno | Prompt exacto enviado al proveedor de visión. |
| `cacheMaxEntries` | `256` | Entradas de la caché de análisis por sesión. |
| `debug` | `false` | Logs de depuración (`[vision-relay]`). Nunca imprime claves. |

---

## Cómo se comporta

1. **Solo actúa con imágenes**: sin `media` parts de tipo `image/*` no se llama al proveedor.
2. **No interviene con modelos con visión**: la detección usa el **catálogo
   completo de modelos** de tu opencode2 (`model.list()`) — o sea, **cualquier
   provider que conectes** y declare `image`/`media` en sus `capabilities.input`
   se respeta automáticamente: las imágenes pasan sin tocarlas. Los modelos sin
   capacidades declaradas (o desconocidos) se procesan igualmente
   (`processUnknownModels`, default `true`), con `skipModels` como override
   manual.
3. **Modelos text-only**: cada imagen se analiza (una llamada por imagen) y se reemplaza *in situ* por un bloque de texto:
   ```
   [IMAGE 1 ANALYSIS]
   <análisis estructurado>
   [/IMAGE 1 ANALYSIS]
   ```
4. **Auto-redimensionado**: las imágenes PNG/JPEG más anchas que `maxResizeWidth` se reducen antes de enviarlas — una captura a pantalla completa se analiza en segundos con calidad suficiente para leer texto/UI. Otros formatos pasan intactos.
5. **Se conserva el texto original** del usuario: solo se reemplazan las partes `media`, nunca las de texto.
6. **Múltiples imágenes**: se numeran en orden de aparición y cada una genera su bloque independiente.
7. **La conversación guardada no se modifica**: la transformación ocurre solo sobre la petición saliente hacia el modelo.
8. **Caché por sesión**: la misma imagen en turnos posteriores no se vuelve a enviar al proveedor.
9. **Errores limpios**: si el proveedor falla, la imagen se sustituye por un aviso `ERROR: …` visible para el modelo; el plugin nunca lanza hacia el dispatcher.
10. **Seguridad**: la API key solo se lee de `process.env`/archivo; los logs redactan cuerpos de error y jamás incluyen claves.

### Cómo se analizan las imágenes (incluye modelos AI SDK)

El análisis ocurre en un **hook de contexto, antes** del dispatch del modelo:
las imágenes se envían al proveedor una a una y, al terminar, la petición al
modelo sale con los bloques `[IMAGE N ANALYSIS]` — **el modelo nunca recibe
bytes de imagen**. No hay un *panel de razonamiento* mientras se analiza: la
espera es muda y depende del proveedor (normalmente segundos por imagen). El
`timeoutMs` acota el análisis de cada imagen; el stream del modelo final no se
interrumpe aunque una imagen tarde más (esa imagen se marca `ERROR: …` y el
resto continúa).

---

## Solución de problemas

| Problema | Solución |
| --- | --- |
| `GOOGLE_AI_STUDIO_API_KEY is not set` | Ni la env var ni `~/.config/opencode/vision-relay.key` tienen la key. Usa el método de archivo (rápido y estable). |
| El plugin vuelve a pedir la key tras reiniciar | El archivo de key se relee en cada envío; verifica que exista y contenga solo la clave. |
| No aparece `opencode.vision-relay` en `/api/plugin` | `opencode2 service restart`; si sigue faltando, activa `debug: true` y revisa el log del servidor. |
| `HTTP 429` del proveedor | Límite de peticiones. Espera unos segundos o baja `maxImagesPerMessage`. |
| `HTTP 401` | La API key es inválida. Regenera la del proveedor (p. ej. en Google AI Studio). |
| La imagen no se analiza | Comprueba formato (PNG/JPEG/GIF/WebP) y que no supere `maxImageBytes` (15 MiB por defecto). |
| El análisis tarda demasiado | Bajadando `maxResizeWidth` (default 2000) reduces el envío; también baja `timeoutMs` si prefieres fallar rápido. |

Para logs detallados: `{ "options": { "debug": true } }` muestra líneas
`[vision-relay]` (proveedor, modelo, nº de imágenes, caché).

---

## Desinstalación

1. Quita la entrada del plugin de `opencode.json` (o la clave `plugins`).
2. Opcional: `npm uninstall -g opencode2-vision-relay` o elimina la carpeta.
3. Reinicia OpenCode. La lista `/api/plugin` deja de incluirlo.

---

## Limitaciones

- **Hook beta**: la API de plugins V2 (y el hook `context`) es beta; puede
  cambiar entre versiones. Mantén `@opencode-ai/plugin` en la misma versión que
  tu CLI.
- **Imágenes**: OpenCode V2 convierte en `media` parts los archivos
  `image/png`, `image/jpeg`, `image/gif` y `image/webp` adjuntos. Otros
  formatos siguen el flujo estándar de OpenCode.
- **Coste**: cada imagen nueva consume una llamada al proveedor (la caché por
  sesión evita reanálisis en turnos posteriores).
- El plugin procesa imágenes presentes en **cualquier** dispatch con el modelo
  activo (incluida la conversación previa si el modelo es text-only), siempre
  bajo los límites configurados.

---

## Licencia

MIT — ver [LICENSE](LICENSE).

## Desarrollo y contribución

¿Quieres probar más a fondo, reportar un bug o publicar una versión nueva?
Todo lo relativo a tests, build, arquitectura y release está en
[`CONTRIBUTING.md`](https://github.com/killershadow336/opencode-vision-relay/blob/main/CONTRIBUTING.md).