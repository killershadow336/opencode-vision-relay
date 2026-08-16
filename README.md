# opencode-vision-relay

> 💡 ¿Quieres empezar ya? Sigue la [**Guía rápida paso a paso**](GUIA.md).

Plugin **nativo** de OpenCode V2 que da visión a modelos que solo aceptan texto.

Cuando el usuario adjunta una imagen, el plugin la envía a **Gemini** (Google AI
Studio, endpoint OpenAI-compatible) y reemplaza la imagen por una descripción
textual detallada antes de que llegue al modelo principal. Así un modelo
text-only como `opencode/deepseek-v4-flash-free` puede "ver" imágenes.

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
Gemini (gemini-3.6-flash) analiza la imagen
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
- Una API key de Google AI Studio (`GOOGLE_AI_STUDIO_API_KEY`).

## Instalación

Copia la carpeta `plugin/` donde quieras y referencia su `index.ts` desde la
configuración de OpenCode V2 (`opencode.json`, ver
[plugins](https://opencode.ai/v2/docs/build/plugins)).

```sh
cd plugin
npm install        # o: bun install
```

Añade el plugin a tu `opencode.json` (puede ser global en
`~/.config/opencode/opencode.json` o por proyecto):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./plugin/index.ts"
  ]
}
```

> La ruta es relativa al archivo de configuración. También puedes usar el
> objeto para pasar opciones:
>
> ```jsonc
> "plugins": [
>   {
>     "package": "./plugin/index.ts",
>     "options": {
>       "model": "gemini-3.6-flash",
>       "maxImagesPerMessage": 6,
>       "debug": true
>     }
>   }
> ]
> ```

Reinicia/relanza OpenCode y verifica que el plugin se cargó:

```sh
opencode2 api get /api/plugin
```

Debe aparecer `opencode.vision-relay` en la lista.

## Variables de entorno y archivo de key

El plugin resuelve la API key **en cada envío**, en este orden:
`GOOGLE_AI_STUDIO_API_KEY` (env) → `~/.config/opencode/vision-relay.key`
(archivo). El archivo es el mecanismo **estable**: aunque el servicio de
OpenCode se reinicie desde cualquier proceso sin tu env var, el plugin relee el
archivo y la key siempre está disponible.

```sh
# Método recomendado — archivo (persiste a reinicios del servicio):
mkdir -p ~/.config/opencode
printf '%s' 'tu_api_key_de_google_ai_studio' > ~/.config/opencode/vision-relay.key

# Alternativa — variable de entorno (solo sirve si el proceso que arranca
# el servicio la tiene exportada):
export GOOGLE_AI_STUDIO_API_KEY="tu_api_key_de_google_ai_studio"
export VISION_MODEL="gemini-3.6-flash"   # opcional, por defecto gemini-3.6-flash
```

- `GOOGLE_AI_STUDIO_API_KEY` — **obligatoria** para analizar imágenes (o el
  archivo de respaldo). El plugin nunca la imprime en logs.
- `VISION_MODEL` — modelo Gemini a usar (se puede sobrescribir con la opción
  `model`). Requiere un modelo multimodal del catálogo de Google AI Studio.

## Configuración (opciones)

| Opción | Default | Descripción |
| --- | --- | --- |
| `enabled` | `true` | Apaga el plugin por completo. |
| `model` | env `VISION_MODEL` → `gemini-3.6-flash` | Modelo Gemini. |
| `endpoint` | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | Endpoint OpenAI-compatible. |
| `apiKeyEnv` | `GOOGLE_AI_STUDIO_API_KEY` | Variable de entorno de la API key. |
| `apiKeyFile` | `~/.config/opencode/vision-relay.key` | Respaldode la API key: se lee en cada envío si la env var no existe. |
| `timeoutMs` | `190000` | Timeout por imagen con Gemini (mín. 1000). Solo aplica al análisis de cada imagen; el stream del modelo no se corta por este valor. |
| `maxTokens` | `2048` | `max_tokens` de la respuesta de Gemini (mín. 64). |
| `maxImagesPerMessage` | `10` | Máx. imágenes analizadas por mensaje; el resto se marca como omitidas (mín. 1). |
| `maxImageBytes` | `15728640` (15 MiB) | Máx. bytes decodificados por imagen; por encima se omite con aviso (mín. 1024). |
| `skipModels` | `[]` | IDs de modelo que nunca se procesan (ya ven imágenes). |
| `alwaysProcessModels` | `[]` | IDs de modelo que siempre se procesan, aunque el catálogo diga que ven imágenes. |
| `processUnknownModels` | `true` | Si el modelo no aparece en el catálogo, se procesa igualmente. |
| `visionPrompt` | prompt interno | Prompt exacto enviado a Gemini. |
| `cacheMaxEntries` | `256` | Entradas de la caché de análisis por sesión. |
| `debug` | `false` | Logs de depuración (`[vision-relay]`). Nunca imprime claves. |

## Comportamiento

1. **Solo actúa con imágenes**: si el mensaje no contiene ningún `media` part
   de tipo `image/*`, no se hace ninguna llamada a Gemini.
2. **No interviene con modelos con visión**: consulta el catálogo
   (`ctx.catalog.model.list()`) y si el modelo activo soporta `image` (o
   `media`) en `capabilities.input`, deja pasar las imágenes sin tocar nada.
3. **Modelos text-only**: cada imagen se envía a Gemini (una llamada por
   imagen) y se sustituye *in situ* por un bloque de texto:

   ```
   [IMAGE 1 ANALYSIS]
   Descripción del usuario: <si se incluyó>
   <análisis estructurado de Gemini>
   [/IMAGE 1 ANALYSIS]
   ```

4. **Se conserva el texto original** del usuario: solo se reemplazan las
   partes `media`, nunca las partes de texto.
5. **Múltiples imágenes**: se numeran en orden de aparición y cada una genera
   su bloque independiente.
6. **La conversación original no se modifica**: el hook muta únicamente la
   petición saliente del modelo, no el historial guardado.
7. **Caché por sesión**: la misma imagen en turnos posteriores se reutiliza sin
   volver a llamar a Gemini.
8. **Errores limpios**: si Gemini falla, la imagen se sustituye por un aviso
   `ERROR: …` visible para el modelo y el plugin **nunca lanza** hacia el
   dispatcher (un hook que falla rompería la petición).
9. **Límites**: número de imágenes por mensaje y tamaño por imagen son
   configurables; las omitidas se notifican en texto.
10. **Seguridad**: la API key solo se lee de `process.env`; los logs redactan
    cuerpos de error y jamás incluyen claves.

### Streaming en modelos AI SDK (`aisdk:...`)

En modelos text-only enrutados por AI SDK (p. ej. DeepSeek vía OpenCode),
el plugin no espera en silencio a que Gemini termine: el análisis fluye **en
vivo** como `reasoning-*` parts en el panel de razonamiento mientras Gemini
trabaja. Una vez terminadas todas las imágenes, la petición al modelo real se
envía con los bloques de análisis en lugar de las imágenes (el modelo nunca
recibe bytes de imagen).

El `timeoutMs` solo acota el análisis de **cada imagen** con Gemini. El stream
del modelo final se reenvía sin cortes: aunque Gemini tarde más, la respuesta
ensamblada no se interrumpe; a lo sumo esa imagen se marca con
`ERROR: …` y el resto continúa.

## Uso

```sh
# con el plugin activo y la API key exportada
opencode2
```

Adjunta una imagen (o varias) y escribe tu petición, por ejemplo:

> Mira esta captura, ¿qué error estoy viendo?

DeepSeek recibirá el texto original más el análisis de Gemini y podrá razonar
sobre la imagen.

## Pruebas

```sh
cd plugin
npm test          # Vitest: 14 casos
npm run typecheck # tsc --noEmit
```

Los casos cubren:
- **A)** mensaje sin imagen → Gemini no se llama
- **B)** una imagen → Gemini recibe la data URI, devuelve descripción, DeepSeek
  recibe el bloque `[IMAGE 1 ANALYSIS]`
- **C)** varias imágenes → todas procesadas, bloques numerados e independientes
- **D)** error de Gemini → no rompe nada, se inserta aviso
- además: límites de tamaño/cantidad, parseo de respuestas OpenAI-compatible,
  normalización de data URIs y sustituciones por aviso.

## Debugging

```jsonc
{ "options": { "debug": true } }
```

Muestra logs `[vision-relay]` (modelo, nº de imágenes, caché). Para ver el
procesamiento del servidor en general:

```sh
opencode2 service status
opencode2 api get /api/health
```

Si el plugin no aparece en `/api/plugin`, revisa el log del servidor
(`~/.local/share/opencode/log/opencode.log`, filtrar `role=server`). Los
módulos que fallan al cargar se registran sin romper el resto.

## Desinstalación

1. Quita la entrada del plugin de `opencode.json` (o `plugins`).
2. Opcional: elimina la carpeta `plugin/`.
3. Reinicia OpenCode. La lista `/api/plugin` deja de incluirlo.

## Limitaciones

- **Hook beta**: la API de plugins V2 (y el hook `context`) es beta; puede
  cambiar entre versiones. Mantén `@opencode-ai/plugin` en la misma versión que
  tu CLI.
- **Imágenes**: OpenCode V2 convierte en `media` parts los archivos
  `image/png`, `image/jpeg`, `image/gif` y `image/webp` adjuntos. Otros
  formatos siguen el flujo estándar de OpenCode.
- **Coste**: cada imagen nueva consume una llamada a Gemini (la caché por
  sesión evita reanálisis en turnos posteriores).
- El plugin procesa imágenes presentes en **cualquier** dispatch con el modelo
  activo (incluida la conversación previa si el modelo es text-only), siempre
  bajo los límites configurados.
