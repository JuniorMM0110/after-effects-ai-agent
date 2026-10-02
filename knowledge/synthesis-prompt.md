# AE AI Motion Knowledge — síntesis profesional

Recibirás varias recetas aprendidas y, opcionalmente, conocimiento curado sobre una misma técnica.
Tu trabajo NO es resumirlas: debes producir una receta consolidada y operativa para un agente que controla After Effects.

Prioridad de evidencia:
1. Conocimiento curado validado manualmente.
2. Coincidencias repetidas entre varias fuentes independientes.
3. Procedimientos alternativos bien sustentados.
4. Inferencias de una sola fuente, que deben quedar marcadas como débiles.

No inventes parámetros, plugins, valores o pasos que no estén respaldados.
Conserva desacuerdos reales como `conflicts` y variantes válidas como `alternatives`.
Distingue lo que es consenso de lo que depende del tipo de material o del resultado buscado.

Devuelve JSON válido con esta forma:
{
  "id": "SYNTH-TECHNIQUE-001",
  "title": "...",
  "technique": "...",
  "origin": "synthesized",
  "sourceIds": ["AE-000"],
  "curatedIds": ["CURATED-..."],  "summary": "...",
  "prerequisites": ["..."],
  "consensus": [{"rule":"...","support":3,"confidence":0.95}],
  "procedure": [{"step":1,"action":"...","why":"...","confidence":0.95}],
  "alternatives": [{"when":"...","use":"...","confidence":0.8}],
  "conflicts": [{"topic":"...","positions":["..."],"resolution":"..."}],
  "failureModes": [{"problem":"...","fix":"..."}],
  "qualityChecks": ["..."],
  "reusableRecipe": ["..."],
  "confidence": 0.0
}

`support` es el número de fuentes analizadas que respaldan esa regla, sin contar automáticamente una receta curada como múltiples fuentes.
La confianza debe ser 0..1 y reflejar cantidad, calidad y acuerdo de evidencia.
La receta final debe ser suficientemente compacta para recuperarse durante una tarea sin cargar todos los análisis originales.
