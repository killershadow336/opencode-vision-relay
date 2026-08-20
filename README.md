# opencode2-vision-relay

> 💡 ¿Quieres empezar ya con Gemini? Sigue la [**Guía rápida paso a paso**](GUIA.md).

Plugin **nativo** de OpenCode V2 que da visión a modelos que solo aceptan texto.

Cuando el usuario adjunta una imagen, el plugin la envía al **proveedor de visión**
que elijas — **Gemini** por defecto, o cualquier API compatible con OpenAI
(OpenAI, Groq, OpenRouter, Ollama, LM Studio…) — y reemplaza la imagen por una
descripción textual detallada antes de que llegue al modelo principal. Así un
modelo text-only como `opencode/deepseek-v4-flash-free` puede "ver" imágenes.

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
DeepSeek V4 recibe solo texto y responde
```

No modifica OpenCode, no usa proxy externo, y no toca la conversación guardada:
solo transforma la petición saliente hacia el modelo.

---

## Requisitos

- OpenCode V2 (`opencode2`). Desarrollado y probado con `0.0.0-next-17444`
  (el paquete `@opencode-ai/plugin` debe coincidir con la versión del CLI).
- Node.js ≥ 20 o Bun (para resolver dependencias del plugin).
- Una API key del proveedor de visión elegido (Gemini, OpenAI, Groq, etc.).

## Instalación

Hay tres formas: **paquete npm** (cuando esté publicado), **GitHub** o **carpeta local**.

### Desde npm (recomendado para usuarios)

```sh
npm install -g opencode2-vision-relay   # no publicado todavía — usa GitHub/local por ahora
```

Añade el paquete a tu `opencode.json`:

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

### Desde la carpeta local (desarrollo / fork)

```sh
git clone https://github.com/killershadow336/opencode-vision-relay.git
cd opencode-vision-relay
npm install        # o: bun install
npm run build      # genera dist/
```

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./opencode-vision-relay/dist/index.js",
      "options": { "provider": "gemini" }
    }
  ]
}
```

> En dev también puedes apuntar a `index.ts` directamente (OpenCode carga TS
> nativo); `dist/index.js` es el artefacto publicado.

Reinicia/relanza OpenCode y verifica que el plugin se cargó:

```sh
opencode2 api get /api/plugin
```

Debe aparecer `opencode.vision-relay` en la lista.

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
    {
      "package": "opencode2-vision-relay",
      "options": {}
    }
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

## Variables de entorno y archivo de key

El plugin resuelve la API key **en cada envío**, en este orden: env var →
archivo de respaldo. El mecanismo de archivo es **estable**: aunque el servicio
de OpenCode se reinicie desde cualquier proceso sin tu env var, el plugin relee
el archivo y la key siempre está disponible.

**Gemini** (default):

```sh
# Método recomendado — archivo (persiste a reinicios del servicio):
mkdir -p ~/.config/opencode
printf '%s' 'tu_api_key_de_google_ai_studio' > ~/.config/opencode/vision-relay.key

# Alternativa — variable de entorno:
export GOOGLE_AI_STUDIO_API_KEY="tu_api_key_de_google_ai_studio"
export VISION_MODEL="gemini-3.6-flash"   # opcional, por defecto gemini-3.6-flash
```

**OpenAI genérico**: `OPENAI_API_KEY` o `~/.config/opencode/openai.key`.
Proveedores personalizados: la `apiKeyEnv`/`apiKeyFile` que definas.

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
| `timeoutMs` | `190000` | Timeout por imagen (mín. 1000). Solo aplica al análisis de cada imagen; el stream del modelo no se corta por este valor. |
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

## Comportamiento

1. **Solo actúa con imágenes**: si el mensaje no contiene ningún `media` part
   de tipo `image/*`, no se hace ninguna llamada al proveedor de visión.
2. **No interviene con modelos con visión**: consulta el catálogo
   (`ctx.catalog.model.list()`) y si el modelo activo soporta `image` (o
   `media`) en `capabilities.input`, deja pasar las imágenes sin tocar nada.
3. **Modelos text-only**: cada imagen se envía al proveedor de visión (una
   llamada por imagen) y se sustituye *in situ* por un bloque de texto:
   ```
   [IMAGE 1 ANALYSIS]
   <análisis estructurado>
   [/IMAGE 1 ANALYSIS]
   ```
4. **Auto-redimensionado**: las imágenes PNG/JPEG más anchas que
   `maxResizeWidth` (2000 px por defecto) se reducen antes de enviarlas —
   una captura a pantalla completa baja de minutos a segundos de análisis con
   calidad suficiente para leer texto/UI. Los demás formatos pasan intactos.
4. **Se conserva el texto original** del usuario: solo se reemplazan las
   partes `media`, nunca las partes de texto.
5. **Múltiples imágenes**: se numeran en orden de aparición y cada una genera
   su bloque independiente.
6. **La conversación original no se modifica**: el hook muta únicamente la
   petición saliente del modelo, no el historial guardado.
7. **Caché por sesión**: la misma imagen en turnos posteriores se reutiliza sin
   volver a llamar al proveedor.
8. **Errores limpios**: si el proveedor falla, la imagen se sustituye por un
   aviso `ERROR: …` visible para el modelo y el plugin **nunca lanza** hacia el
   dispatcher (un hook que falla rompería la petición).
9. **Límites**: número de imágenes por mensaje y tamaño por imagen son
   configurables; las omitidas se notifican en texto.
10. **Seguridad**: la API key solo se lee de `process.env`/archivo; los logs
    redactan cuerpos de error y jamás incluyen claves.

### Streaming en modelos AI SDK (`aisdk:...`)

En modelos text-only enrutados por AI SDK (p. ej. DeepSeek vía OpenCode),
el plugin no espera en silencio a que el proveedor termine: el análisis fluye
**en vivo** como `reasoning-*` parts en el panel de razonamiento mientras el
proveedor trabaja. Una vez terminadas todas las imágenes, la petición al modelo
real se envía con los bloques de análisis en lugar de las imágenes (el modelo
nunca recibe bytes de imagen).

El `timeoutMs` solo acota el análisis de **cada imagen**. El stream del modelo
final se reenvía sin cortes: aunque el proveedor tarde más, la respuesta
ensamblada no se interrumpe; a lo sumo esa imagen se marca con `ERROR: …` y el
resto continúa.

## Uso

```sh
# con el plugin activo y la API key del proveedor configurada
opencode2
```

Adjunta una imagen (o varias) y escribe tu petición, por ejemplo:

> Mira esta captura, ¿qué error estoy viendo?

El modelo recibirá el texto original más el análisis del proveedor y podrá
razonar sobre la imagen.

## Pruebas

```sh
npm test          # Vitest: 45 casos
npm run typecheck # tsc --noEmit
```

Los casos cubren:
- **A)** mensaje sin imagen → el proveedor no se llama
- **B)** una imagen → el proveedor recibe la data URI, devuelve descripción, el
  modelo recibe el bloque `[IMAGE 1 ANALYSIS]`
- **C)** varias imágenes → todas procesadas, bloques numerados e independientes
- **D)** error del proveedor → no rompe nada, se inserta aviso
- **providers**: resolución de proveedores (gemini/openai/personalizados),
  `baseUrl`→endpoint, overrides y fallback con warning
- **resize**: redimensionado PNG/JPEG (tamaños, aspect ratio, passthrough de
  formatos sin decodificador y de imágenes pequeñas, integración en relay)
- además: límites de tamaño/cantidad, parseo de respuestas OpenAI-compatible,
  normalización de data URIs y sustituciones por aviso.

## Build & publicación

```sh
npm run build      # tsc → dist/ (JS + .d.ts + maps)
npm pack           # genera el tarball publicable (prepack: build + test)
npm publish        # requiere npm login y un paquete sin "private": true
```

El tarball incluye `dist/`, `README.md`, `GUIA.md` y `LICENSE`. La única
dependencia runtime es `@opencode-ai/plugin` (los demás imports son tipos y se
borran al compilar). **No subas dist/ al repo** (está en `.gitignore`); se
genera en `prepack`/`prepublish`.

## Debugging

```jsonc
{ "options": { "debug": true } }
```

Muestra logs `[vision-relay]` (proveedor, modelo, nº de imágenes, caché). Para
ver el procesamiento del servidor en general:

```sh
opencode2 service status
opencode2 api get /api/health
```

Si el plugin no aparece en `/api/plugin`, revisa el log del servidor
(`~/.local/share/opencode/log/opencode.log`, filtrar `role=server`). Los
módulos que fallan al cargar se registran sin romper el resto.

## Desinstalación

1. Quita la entrada del plugin de `opencode.json`.
2. Opcional: `npm uninstall -g opencode2-vision-relay` o elimina la carpeta.
3. Reinicia OpenCode. La lista `/api/plugin` deja de incluirlo.

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