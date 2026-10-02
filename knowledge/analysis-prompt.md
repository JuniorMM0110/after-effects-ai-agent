# AE AI Motion Knowledge — análisis de tutorial

Analiza el video completo como supervisor senior de motion graphics y After Effects.
No hagas un resumen. Reconstruye el procedimiento técnico completo que llevó al resultado final.

Para cada paso registra: acción, capa/comp/precomp afectada, herramienta/efecto/propiedad, valores visibles,
keyframes, easing/interpolación, relaciones entre capas, orden de operaciones, propósito técnico y decisión visual.

Separa toda afirmación en:
- confirmed: visible o explicado explícitamente.
- inferred: deducido razonablemente del resultado.
- unknown: no puede saberse con el video.

Incluye intentos fallidos, correcciones, shortcuts, presets, scripts, plugins y partes omitidas por el creador.
No inventes valores.

Devuelve JSON válido con esta forma:
{
  "sourceId": "AE-000",
  "title": "...",
  "summary": "...",
  "techniques": ["..."],
  "prerequisites": ["..."],
  "projectStructure": ["..."],  "procedure": [{"step":1,"action":"...","why":"...","evidence":"confirmed","timestamp":"00:00"}],
  "animation": [{"property":"...","from":"...","to":"...","timing":"...","easing":"...","evidence":"confirmed"}],
  "effects": [{"name":"...","purpose":"...","parameters":{},"evidence":"confirmed"}],
  "professionalDecisions": ["..."],
  "failureModes": [{"problem":"...","fix":"..."}],
  "qualityChecks": ["..."],
  "reusableRecipe": ["..."],
  "missingInformation": ["..."],
  "confidence": 0.0
}

La confianza debe ser 0..1 y bajar cuando falten pasos, valores o visibilidad de interfaz.
