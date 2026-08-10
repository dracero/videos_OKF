# Catálogo de YouTube Diego Racero: RAG & Open Knowledge Format (OKF)

Esta plataforma es un sistema interactivo diseñado para extraer, almacenar, estructurar y consultar semánticamente los canales y videos de YouTube de **Diego Racero** (`dracero@fi.uba.ar`). 

Combina la especificación abierta **Open Knowledge Format (OKF)** para estructurar el catálogo como un grafo de conocimiento portátil, y un motor de **Búsqueda Semántica RAG (Retrieval-Augmented Generation)** gratuito y 100% local que procesa tanto los metadatos como el contenido hablado (transcripciones de audio).

---

## 🏗️ Arquitectura del Sistema

El sistema opera en dos fases desacopladas: **Ingesta e Indexación** (sincronización y vectorización en lote) y **Búsqueda e Interacción** (búsqueda semántica unificada en tiempo real y deep linking temporal).

### 1. Grafo de Ingesta, Enriquecimiento e Indexación Semántica

Este diagrama detalla cómo se extrae la información de YouTube, se estructuran los documentos bajo el formato OKF, se genera el resumen enriquecido a partir de audio/subtítulos, y se indexan los vectores de catálogo y chunks:

```mermaid
flowchart TD
    subgraph Ingestion["Fase 1: Ingesta y Estructuración OKF"]
        YT["YouTube Data API v3"] -->|"1. Sincronización"| Sync["sync.js (Sync Engine)"]
        Sub["youtube-transcript"] -->|"2. Descarga Subtítulos"| Sync
        Sync -->|"3. Escribe Markdown / YAML"| Files["Directorio src/content/okf/"]
        
        Files -->|"Concepto Canal"| Chan["channels/:channelId.md"]
        Files -->|"Concepto Video"| Vid["videos/:videoId.md"]
        Files -->|"Índice Raíz"| Idx["index.md"]
        Files -->|"Sidecar Audio"| Trans["transcripts/:videoId.json"]
    end

    subgraph RAG_Pipeline["Fase 2: Enriquecimiento e Indexación Semántica"]
        Trans -->|"4. Primeras ~200 palabras"| Summarizer["Generador de Resúmenes"]
        Summarizer -->|"5. Guarda transcript_summary"| Vid
        
        Vid -->|"6. Título + tags + resumen"| EmbedCatalog["Vectorizador Catálogo (semantic-search.js)"]
        Trans -->|"7. Split Chunks ~150 palabras"| Chunking["Segmentación Textual"]
        
        Vid -->|"8. Contexto OKF (Video/Canal)"| EmbedChunks["Vectorizador Chunks (semantic-search.js)"]
        Chunking -->|"9. Contenido de Voz"| EmbedChunks
        
        EmbedCatalog -->|"all-MiniLM-L6-v2"| JSON_Cat["embeddings.json (Vectores Catálogo)"]
        EmbedChunks -->|"all-MiniLM-L6-v2"| JSON_Chunks["embeddings_chunks.json (Vectores Chunks)"]
    end
```

### 2. Flujo de Consulta Semántica Unificada y Deep Linking

Este diagrama describe la interacción del usuario al realizar una consulta semántica, cómo el motor fusiona y deduplica los vectores de catálogo y de transcripción, y cómo se realiza la reproducción automática desde el segundo exacto:

```mermaid
flowchart TD
    User["Usuario / Navegador"] -->|"1. Input: 'home assistant'"| FE["Astro Web Frontend (index.astro)"]
    FE -->|"2. GET /api/semantic-search?q=..."| API["API Endpoint"]
    API -->|"3. Vectoriza Consulta"| Model["all-MiniLM-L6-v2"]
    
    Model -->|"4. Consulta Vectorial"| VectorSearch["Buscador Vectorial (semantic-search.js)"]
    VectorSearch -->|"Cálculo Similitud Coseno"| JSON_Cat["embeddings.json"]
    VectorSearch -->|"Cálculo Similitud Coseno"| JSON_Chunks["embeddings_chunks.json"]
    
    VectorSearch -->|"5. Resultados Semánticos"| Fusion["Algoritmo de Fusión e Hibridación"]
    Fusion -->|"Keyword Match Boost"| Fusion
    Fusion -->|"Deduplicación por Video"| Fusion
    
    Fusion -->|"6. Retorna Lista Fusionada"| API
    API -->|"7. Render Intercalado"| FE
    FE -->|"8. Clic en: 'Ir al minuto 00:03'"| Link["Navigates to /videos/:id?t=3"]
    Link -->|"9. SSR: Inyecta start=3&autoplay=1"| Embed["YouTube Iframe Player"]
```

---

## 📖 Integración OKF (Open Knowledge Format)

El **Open Knowledge Format (OKF)** es una especificación abierta e independiente de proveedores introducida por Google Cloud para empaquetar conocimiento organizacional de manera que sea fácilmente entendible tanto por humanos como por sistemas de inteligencia artificial (LLMs/Agentes).

### Estructura de Archivos en el Catálogo
La base de datos del proyecto se almacena en texto plano en Git dentro de `src/content/okf/`:
*   **Índice (`index.md`):** Nodo raíz del catálogo. Mapea la procedencia de los datos e incluye links relativos a los canales.
*   **Canales (`channels/*.md`):** Conceptos que describen cada canal de YouTube, sus estadísticas básicas y su handle.
*   **Videos (`videos/*.md`):** Conceptos individuales de cada video sincronizado.
*   **Sidecars (`transcripts/*.json`):** Transcripciones completas descargadas de cada video con sus respectivos offsets de tiempo en milisegundos.

### Frontmatter Enriquecido (Ejemplo Real: `fu6Mw97RVSc.md`)
Cada concepto OKF contiene un encabezado estructurado en **YAML Frontmatter** que describe de forma declarativa sus metadatos, procedencia (*sources*) y resumen de contenido:

```yaml
---
type: YouTube Video
title: "HA_video2"
description: "Configuración inicial de Home Assistant"
transcript_summary: "Bueno, lo que voy a mostrar ahora es cómo hacer para conectarme al Home Assistant y configurar una cámara ONVIF de forma automática..."
resource: "https://www.youtube.com/watch?v=fu6Mw97RVSc"
tags: ["youtube", "video", "home-assistant"]
generated: { by: "process:sync-youtube", at: "2026-08-10T17:03:55.875Z" }
verified: machine-confirmed
status: current
channel_id: "UCbSbKX3V4J28e4iJtulgEQA"
published_at: "2026-08-09T21:23:17Z"
view_count: 8
like_count: 0
comment_count: 0
duration: "12:33"
thumbnail: "https://i.ytimg.com/vi/fu6Mw97RVSc/maxresdefault.jpg"
sources:
  - id: youtube-api
    resource: "https://developers.google.com/youtube/v3"
    title: "YouTube Data API v3"
    last_modified: "2026-08-10"
  - id: channel-concept
    resource: "src/content/okf/channels/UCbSbKX3V4J28e4iJtulgEQA.md"
    title: "Channel: DiegoTestDireco"
---
```

---

## 🧠 Algoritmo de Búsqueda Semántica Unificada (RAG)

El motor de búsqueda semántica opera localmente en la CPU/GPU del servidor mediante la biblioteca `@xenova/transformers` corriendo el modelo pre-entrenado de 384 dimensiones **`Xenova/all-MiniLM-L6-v2`** (aprox. 90MB).

Para optimizar la precisión y resolver las limitaciones típicas de las bases de conocimiento dispersas, se aplican las siguientes técnicas:

### 1. Resolución de Dispersión de Metadatos (Metadata Sparsity)
Más del 96% de los videos no poseen descripciones detalladas ni tags en YouTube. Para evitar que el buscador semántico de metadatos falle por falta de información conceptual, el script de sincronización genera de forma automática un **resumen de transcripción** (`transcript_summary`) con las primeras ~200 palabras pronunciadas en el video y lo inyecta como metadato permanente en el archivo OKF.

### 2. Segmentación Contextual de Transcripciones (Context-Aware Chunking)
El audio de los videos se divide en fragmentos ("chunks") solapados de aproximadamente 150 palabras para ajustarse al contexto semántico fino.
Para evitar que un chunk pierda su relación con el video de origen al vectorizarse, el texto enviado al modelo de embeddings se genera preponiendo el contexto del nodo OKF al que pertenece:

$$\text{Texto Vectorizado} = \text{"Video: \"[Título]\" | Canal: \"[Canal]\" | Contenido: [Texto Hablado]"}$$

De este modo, una búsqueda que contenga el nombre del video o palabras del canal coincidirá semánticamente mucho mejor con sus chunks internos de audio.

### 3. Búsqueda Vectorial Híbrida (Hybrid Retrieval & Keyword Boost)
El cálculo primario de coincidencia se basa en la **similitud de coseno** entre los vectores normalizados:

$$\text{Similitud} = \cos(\vec{u}, \vec{v}) = \frac{\vec{u} \cdot \vec{v}}{\|\vec{u}\| \|\vec{v}\|}$$

Dado que los vectores semánticos a veces sufren para distinguir términos de código específicos (ej. "Home Assistant" vs "Wit.ai"), implementamos un **Keyword Boost**:
* Si hay coincidencia exacta de la frase de búsqueda dentro del texto del segmento, se le añade un **boost matemático de +0.35** al score de similitud.
* Si coinciden palabras clave individuales del query, se añade un boost proporcional de hasta **+0.20**.

### 4. Fusión de Índices y Deduplicación Inteligente
La consulta semántica busca en paralelo en la colección de videos/canales y en la colección de chunks.
Para presentar una interfaz clara al usuario, el algoritmo:
* Agrupa e intercala los resultados por relevancia final.
* Limita a un máximo de **3 segmentos de transcripción por video** para evitar acaparar los resultados.
* Si un video aparece listado en sus segmentos clave (deep-linking), el sistema **oculta la tarjeta general de catálogo** de dicho video, evitando duplicar contenido inútilmente y optimizando la densidad de información.

### 5. Reproducción Dinámica con Deep Linking
Al seleccionar un fragmento de transcripción en los resultados, el enlace redirige al usuario a `/videos/[id]?t=[segundos]`.
El servidor Astro (SSR) lee este parámetro en tiempo real y altera la inicialización del reproductor embebido de YouTube:

```html
<iframe src="https://www.youtube.com/embed/[id]?start=[segundos]&autoplay=1" ...></iframe>
```
Esto fuerza a la API del reproductor de YouTube a iniciar la reproducción de forma interactiva desde el segundo exacto en el que el orador mencionó el término buscado.

---

## 🛠️ Comandos de Desarrollo

Todos los comandos se corren desde la raíz del proyecto en la terminal:

| Comando | Acción |
| :--- | :--- |
| `npm run dev -- --background` | Inicia el servidor Astro SSR en segundo plano (`http://localhost:4321`) |
| `npx astro dev status` | Verifica el estado del servidor en segundo plano |
| `npx astro dev logs` | Visualiza los logs en tiempo real del servidor en segundo plano |
| `npx astro dev stop` | Detiene el servidor en segundo plano |
| `node -e "import('./src/lib/sync.js').then(m => m.syncCatalog({ force: true }))"` | Fuerza la sincronización de videos, descarga de transcripciones y regeneración de vectores de embeddings |
| `npm run build` | Compila el sitio Astro para producción utilizando el adaptador de Node.js |
| `npx playwright test` | Ejecuta la suite de pruebas E2E integradas para validar la funcionalidad |
