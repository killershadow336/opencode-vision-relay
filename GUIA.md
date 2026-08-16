# 🚀 Guía rápida: visión para DeepSeek con Gemini

> Plugin: `opencode.vision-relay` · OpenCode V2 (`opencode2`)

Objetivo: adjuntas una imagen, Gemini la describe y DeepSeek (o cualquier
modelo text-only) puede "verla". **No hay proxy ni modificaciones a OpenCode.**

---

## Paso 1 · Consigue la API key de Gemini (2 min)

1. Entra a **https://aistudio.google.com/apikey** e inicia sesión con tu cuenta de Google.
2. Pulsa **Create API key** → elige un proyecto (o crea uno).
3. Copia la clave que empieza por **`AIza...`**.
4. Guárdala en un sitio seguro. No la subas a ningún repo ni la compartas.

> Es gratis crearla y Gemini Flash tiene capa gratuita.

**Comprueba que la key funciona** (desde tu terminal):

```sh
curl -s "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_API_KEY" \
  -d '{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"di hola"}]}'
```

Si ves una respuesta con `"choices"`, la key es válida. ✅

---

## Paso 2 · Instala las dependencias del plugin (solo una vez)

Desde la carpeta del plugin:

**En WSL / Linux:**
```sh
cd "/mnt/c/Users/killer/Desktop/opencode-vision-relay"
npm install
```

**En Windows (PowerShell):**
```powershell
cd "C:\Users\killer\Desktop\opencode-vision-relay"
npm install
```

> Si `node_modules` ya existe, este paso ya está hecho.

---

## Paso 3 · Configura la API key

El plugin busca la clave en este orden: **variable de entorno**
(`GOOGLE_AI_STUDIO_API_KEY`) y, si no existe, un **archivo de respaldo**
(`~/.config/opencode/vision-relay.key`). El archivo hace el sistema estable:
aunque el servicio de OpenCode se reinicie desde cualquier proceso (y aunque ese
proceso no tenga tu variable de entorno), el plugin siempre encuentra la key.

**Método recomendado — archivo (estable, no depende de la terminal):**
```sh
mkdir -p ~/.config/opencode
printf '%s' 'AIza...tu-clave-real' > ~/.config/opencode/vision-relay.key
```
(cambia `AIza...tu-clave-real` por tu clave real. No hace falta reiniciar la
terminal ni volver a poner nada si el servicio se reinicia).

**Alternativa — variable de entorno:**
```sh
echo 'export GOOGLE_AI_STUDIO_API_KEY="AIza..."' >> ~/.bashrc
source ~/.bashrc
```
(cambia `AIza...` por tu clave real. Recuerda: la variable debe estar en el
entorno del proceso que arranca el servicio; el archivo evita ese problema.)

**Si usas opencode2 desde Windows nativo (PowerShell):**
```powershell
setx GOOGLE_AI_STUDIO_API_KEY "AIza..."
```
Cierra y vuelve a abrir la terminal.

**Opcional — elegir otro modelo de Gemini:**
```sh
echo 'export VISION_MODEL="gemini-3.6-flash"' >> ~/.bashrc
```
Por defecto ya es `gemini-3.6-flash`, así que este paso solo hace falta si
quieres cambiar de modelo.

---

## Paso 4 · Activa el plugin en `opencode.json`

Añade la clave `plugins` a tu configuración de OpenCode V2.

**Global (todos tus proyectos)** — archivo `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/mnt/c/Users/killer/Desktop/opencode-vision-relay/index.ts"
  ]
}
```

**Opciones (todo es opcional):**
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/mnt/c/Users/killer/Desktop/opencode-vision-relay/index.ts",
      "options": {
        "debug": true,
        "maxImagesPerMessage": 6,
        "model": "gemini-3.6-flash"
      }
    }
  ]
}
```

> La ruta debe escribirse como la ve WSL (`/mnt/c/...` o `C:/...`) porque tu `opencode2`
> corre dentro de WSL. Si lo usas desde Windows nativo, usa la ruta Windows.

---

## Paso 5 · Reinicia y comprueba

```sh
opencode2 service restart
opencode2 api get /api/plugin
```

Tienes que ver **`opencode.vision-relay`** en la lista de plugins.

---

## Paso 6 · ¡A usarlo!

1. Abre `opencode2`.
2. Asegúrate de usar un modelo sin visión, p. ej. `opencode/deepseek-v4-flash-free`.
3. **Adjunta una imagen** (arrastra el archivo o pega una captura).
4. Escribe tu petición, por ejemplo:
   - *"¿Qué error aparece en esta captura?"*
   - *"Transcribe el texto de esta imagen"*
   - *"Explícame este diagrama"*
5. Espera: primero Gemini describe la imagen, luego DeepSeek responde.

> Con modelos que **ya** ven imágenes (p. ej. `opencode/mimo-v2.5-free`),
> el plugin se calla y no interviene.

---

## Probar que todo funciona

| Situación | Qué debe pasar |
| --- | --- |
| Mensaje sin imagen | Nada raro, respuesta normal. Gemini NO se llama. |
| Imagen + key configurada | DeepSeek analiza la captura usando la descripción de Gemini. |
| Imagen + sin key | El plugin avisa en el chat de que falta `GOOGLE_AI_STUDIO_API_KEY`. |
| Gemini falla | Aviso de error en el chat, OpenCode no se rompe. |

---

## Solución de problemas

| Problema | Solución |
| --- | --- |
| `GOOGLE_AI_STUDIO_API_KEY is not set` | Ni la variable de entorno ni `~/.config/opencode/vision-relay.key` tienen la key. Crea el archivo (método recomendado del Paso 3) — es estable y no depende de reinicios. |
| El servicio se reinicia y el aviso vuelve a aparecer | El archivo de key resuelve exactamente este problema: el plugin lo relee en cada envío. Verifica que exista y contenga solo la clave. |
| No aparece `opencode.vision-relay` en `/api/plugin` | Ejecuta `opencode2 service restart` y revisa `~/.local/share/opencode/log/opencode.log`. |
| Error `HTTP 429` de Gemini | Límite de peticiones. Espera unos segundos o baja `maxImagesPerMessage`. |
| `401 Unauthorized` | La API key es inválida. Verifícala en Google AI Studio. |
| La imagen no se analiza | Revisa que el formato sea PNG/JPEG/GIF/WebP y que no supere `maxImageBytes` (15 MiB). |

---

## Desinstalar

1. Quita la entrada `plugins` (o la línea del plugin) de `opencode.json`.
2. `opencode2 service restart`.
3. (Opcional) Borra la carpeta `plugin/`.

---

## Comandos útiles

```sh
npm test                # dentro de plugin/: ejecuta los 14 tests
npm run typecheck       # dentro de plugin/: comprobación de tipos
```

Toda la referencia (opciones, formatos, límites, arquitectura) está en
`README.md`.
