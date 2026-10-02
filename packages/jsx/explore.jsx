// explore.jsx — rich one-shot inspection. The whole reason this MCP exists.

// Which keyframes survive a cap, or null when none need to go. Keeping the
// first few and the last few rather than a prefix means the shape of the
// animation — where it starts, where it ends — is still readable.
function __keyframeWindow(total, max) {
  if (!(max > 0) || total <= max) return null;
  var head = Math.ceil(max / 2);
  return { head: head, tail: max - head, total: total, omitted: total - max };
}

// Truncation is never silent: an agent that cannot see what was dropped will
// read a partial answer as the whole one.
function __truncationNote(w) {
  return "first " + w.head + " and last " + w.tail + " of " + w.total + " keyframes; " +
    w.omitted + " omitted — raise maxKeyframes, or read them all with get_keyframes";
}

function __serializeKeyframe(p, k) {
  var entry = { index: k, time: p.keyTime(k), value: p.keyValue(k) };
  try {
    entry["in"] = String(p.keyInInterpolationType(k));
    entry["out"] = String(p.keyOutInterpolationType(k));
  } catch (e1) {}
  try {
    var inE = p.keyInTemporalEase(k);
    var outE = p.keyOutTemporalEase(k);
    entry.easeIn = { influence: inE[0].influence, speed: inE[0].speed };
    entry.easeOut = { influence: outE[0].influence, speed: outE[0].speed };
  } catch (e2) {}
  if (p.isSpatial) {
    try {
      entry.inTangent = p.keyInSpatialTangent(k);
      entry.outTangent = p.keyOutSpatialTangent(k);
    } catch (e3) {}
  }
  return entry;
}

// `opts.maxKeyframes` bounds the response; 0 or absent means every keyframe,
// which is what every caller written before the cap existed gets.
function __serializeProperty(p, opts) {
  var out = {
    name: p.name,
    matchName: p.matchName,
    propertyType: String(p.propertyType),
    isTimeVarying: p.isTimeVarying,
    canSetExpression: p.canSetExpression,
  };
  try { out.value = p.value; } catch (e) {}
  if (p.canSetExpression && p.expression) out.expression = p.expression;
  if (p.numKeys > 0) {
    var total = p.numKeys;
    var w = __keyframeWindow(total, (opts && opts.maxKeyframes) ? opts.maxKeyframes : 0);
    out.keyframes = [];
    for (var k = 1; k <= total; k++) {
      if (w && k > w.head && k <= total - w.tail) continue;
      out.keyframes.push(__serializeKeyframe(p, k));
    }
    if (w) {
      out.keyframeCount = w.total;
      out.keyframesOmitted = w.omitted;
      out.keyframesTruncated = __truncationNote(w);
    }
  }
  return out;
}

function __serializeTransformGroup(tg, opts) {
  var out = {};
  for (var i = 1; i <= tg.numProperties; i++) {
    var p = tg.property(i);
    out[p.name] = __serializeProperty(p, opts);
  }
  return out;
}

// The cap is applied after the fact rather than inside __serializeEffect,
// which effects.jsx also uses for list_effects and add_effect — those return
// one effect and have no size problem to solve.
function __capEffectKeyframes(effects, max) {
  if (!(max > 0)) return effects;
  for (var i = 0; i < effects.length; i++) {
    var params = effects[i].params;
    for (var j = 0; j < params.length; j++) {
      var keys = params[j].keyframes;
      if (!keys) continue;
      var w = __keyframeWindow(keys.length, max);
      if (!w) continue;
      var kept = [];
      for (var k = 0; k < w.total; k++) {
        if (k >= w.head && k < w.total - w.tail) continue;
        kept.push(keys[k]);
      }
      params[j].keyframes = kept;
      params[j].keyframeCount = w.total;
      params[j].keyframesOmitted = w.omitted;
      params[j].keyframesTruncated = __truncationNote(w);
    }
  }
  return effects;
}

function __serializeEffects(layer, opts) {
  var fx = layer.property("Effects");
  if (!fx || fx.numProperties === 0) return [];
  var arr = [];
  for (var i = 1; i <= fx.numProperties; i++) arr.push(__serializeEffect(fx.property(i)));
  return __capEffectKeyframes(arr, (opts && opts.maxKeyframes) ? opts.maxKeyframes : 0);
}

function __serializeMasks(layer, opts) {
  var masks = layer.property("Masks");
  if (!masks || masks.numProperties === 0) return [];
  var out = [];
  for (var i = 1; i <= masks.numProperties; i++) {
    var m = masks.property(i);
    var entry = {
      index: i,
      name: m.name,
      mode: String(m.maskMode),
      inverted: m.inverted,
    };
    try { entry.shape = __serializeProperty(m.property("ADBE Mask Shape"), opts); } catch (e1) {}
    try { entry.opacity = __serializeProperty(m.property("ADBE Mask Opacity"), opts); } catch (e2) {}
    try { entry.expansion = __serializeProperty(m.property("ADBE Mask Offset"), opts); } catch (e3) {}
    try { entry.feather = __serializeProperty(m.property("ADBE Mask Feather"), opts); } catch (e4) {}
    out.push(entry);
  }
  return out;
}

function __serializeMarkers(layer) {
  var mp = layer.property("Marker");
  if (!mp || mp.numKeys === 0) return [];
  var out = [];
  for (var i = 1; i <= mp.numKeys; i++) {
    var mv = mp.keyValue(i);
    out.push({
      index: i,
      time: mp.keyTime(i),
      comment: mv.comment,
      duration: mv.duration,
      label: mv.label,
      chapter: mv.chapter,
      url: mv.url,
      frameTarget: mv.frameTarget,
    });
  }
  return out;
}

function __serializeText(layer) {
  try {
    var td = layer.property("Source Text").value;
    return {
      text: td.text,
      font: td.font,
      fontSize: td.fontSize,
      fillColor: td.applyFill ? [td.fillColor[0], td.fillColor[1], td.fillColor[2]] : null,
      strokeColor: td.applyStroke ? [td.strokeColor[0], td.strokeColor[1], td.strokeColor[2]] : null,
      strokeWidth: td.strokeWidth,
      tracking: td.tracking,
      leading: td.leading,
      justification: String(td.justification),
      fauxBold: td.fauxBold,
      fauxItalic: td.fauxItalic,
      allCaps: td.allCaps,
      smallCaps: td.smallCaps,
    };
  } catch (e) { return null; }
}

// ---------- shape contents ----------
//
// Two of the groups hanging off every vector group are fixed-shape and almost
// never the reason anyone reads a shape layer.
//
// Material Options is the 48-property 3D extrusion model. It means something
// only for an extruded shape under the Cinema 4D renderer, and on the 2D shape
// layers that are nearly all of them it is inert — while being most of the
// weight of a shape read: one 68x68 circle in one group came back as 13KB of
// shape JSON, 10KB of it material properties (issue #42). Skipped unless
// `shapeMaterials` asks for it, and the skip is counted and explained in the
// response rather than being silent.
var __SHAPE_MATERIALS = "ADBE Vector Materials Group";
var __SHAPE_TRANSFORM = "ADBE Vector Transform Group";

// A group Transform still at its creation values says nothing that
// `atDefaults: true` does not. Tested by value rather than through
// PropertyBase.isModified: the values are the contract, they can be asserted
// with no AE to run in, and a property this table does not know about — a
// future AE adding one — has to fail the test rather than be folded away
// unread.
var __VECTOR_TRANSFORM_DEFAULTS = [
  ["ADBE Vector Anchor", [0, 0]],
  ["ADBE Vector Position", [0, 0]],
  ["ADBE Vector Scale", [100, 100]],
  ["ADBE Vector Skew", 0],
  ["ADBE Vector Skew Axis", 0],
  ["ADBE Vector Rotation", 0],
  ["ADBE Vector Group Opacity", 100]
];

function __isPropertyGroup(p) {
  return p.propertyType === PropertyType.NAMED_GROUP || p.propertyType === PropertyType.INDEXED_GROUP;
}

function __vectorTransformDefault(matchName) {
  for (var i = 0; i < __VECTOR_TRANSFORM_DEFAULTS.length; i++) {
    if (__VECTOR_TRANSFORM_DEFAULTS[i][0] === matchName) return __VECTOR_TRANSFORM_DEFAULTS[i][1];
  }
  return null;
}

function __sameVectorValue(a, b) {
  if (b instanceof Array) {
    if (!(a instanceof Array) || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
    return true;
  }
  return a === b;
}

function __isIdentityVectorTransform(tg) {
  if (!tg || !tg.numProperties) return false;
  for (var i = 1; i <= tg.numProperties; i++) {
    var p = tg.property(i);
    // Animated or expression-driven is never "at defaults", whatever it reads
    // at this instant.
    if (p.numKeys > 0) return false;
    try { if (p.canSetExpression && p.expression) return false; } catch (e) {}
    var def = __vectorTransformDefault(p.matchName);
    if (def === null) return false;
    var v;
    try { v = p.value; } catch (e2) { return false; }
    if (!__sameVectorValue(v, def)) return false;
  }
  return true;
}

// Carries the caller's choices down the walk and collects what was left out, so
// the omissions can be named once at the top of the section instead of being
// repeated on every group.
function __shapeOpts(args) {
  return {
    materials: !!(args && args.shapeMaterials),
    compact: !!(args && args.shapeDetail === "compact"),
    materialsOmitted: 0
  };
}

function __serializeShapeContents(group, depth, opts) {
  if (!group || !group.numProperties) return [];
  var out = [];
  for (var i = 1; i <= group.numProperties; i++) {
    var p = group.property(i);
    if (p.matchName === __SHAPE_MATERIALS && !opts.materials) { opts.materialsOmitted += 1; continue; }
    // `index` stays the real one whatever was skipped, so a path built from
    // this response still addresses the node it names.
    var entry = { name: p.name, matchName: p.matchName, index: i };
    if (__isPropertyGroup(p)) {
      if (p.matchName === __SHAPE_TRANSFORM && __isIdentityVectorTransform(p)) entry.atDefaults = true;
      else if (depth > 0) entry.children = __serializeShapeContents(p, depth - 1, opts);
      // Say where the walk stopped. A group that simply has no `children` key
      // reads as empty, which for a deep shape tree is a lie.
      else if (p.numProperties > 0) entry.childrenOmitted = p.numProperties;
    } else {
      try { entry.value = p.value; } catch (e) {}
    }
    out.push(entry);
  }
  return out;
}

// ---------- compact shape serialization ----------
//
// One line per group, with that group's own leaf properties folded onto it.
// The full form spends four JSON lines on every property it reports; the same
// lamp layer is around 450 characters here against 2,800 full (and 13,000
// before the material groups came out). It is a reading format, not a lesser
// one: the write tools address nodes by name, and every name is still on the
// line. `shapeDetail` stays "full" by default all the same — a caller that
// never heard of it has to keep getting exactly what it always got.

function __compactNumber(n) {
  if (typeof n !== "number") return String(n);
  if (isNaN(n) || !isFinite(n)) return String(n);
  // Four decimals round-trips an 8-bit colour channel and keeps float noise
  // (0.6627450980392157 for one byte) out of a format whose point is brevity.
  return String(Math.round(n * 10000) / 10000);
}

function __compactLeafValue(p) {
  var v;
  try { v = p.value; } catch (e) { return "?"; }
  // A path's value is a Shape object, which is a wall of vertex arrays in full
  // and unreadable in one line. Its size and closedness are what you check.
  try {
    if (v && v.vertices && v.vertices.length !== undefined) {
      return "path(" + v.vertices.length + (v.closed ? " verts, closed)" : " verts, open)");
    }
  } catch (e2) {}
  if (v instanceof Array) {
    var parts = [];
    for (var i = 0; i < v.length; i++) parts.push(__compactNumber(v[i]));
    return "[" + parts.join(",") + "]";
  }
  if (typeof v === "number") return __compactNumber(v);
  return String(v);
}

function __compactLeaves(g) {
  var parts = [];
  for (var i = 1; i <= g.numProperties; i++) {
    var p = g.property(i);
    if (__isPropertyGroup(p)) continue;
    var s = p.name + "=" + __compactLeafValue(p);
    if (p.numKeys > 0) s += " [" + p.numKeys + " keys]";
    try { if (p.canSetExpression && p.expression) s += " [expr]"; } catch (e) {}
    parts.push(s);
  }
  return parts.join("  ");
}

// Only the "ADBE " prefix comes off: "ADBE Vector Group" and "ADBE Vectors
// Group" are different nodes, so anything cleverer would collide.
function __compactKind(matchName) {
  return (matchName.substring(0, 5) === "ADBE ") ? matchName.substring(5) : matchName;
}

function __hasGroupChild(g) {
  for (var i = 1; i <= g.numProperties; i++) { if (__isPropertyGroup(g.property(i))) return true; }
  return false;
}

function __compactShapeContents(group, depth, indent, lines, opts) {
  if (!group || !group.numProperties) return lines;
  // Leaves sitting directly on the group being walked have no line of their
  // own to fold onto; at the root, give them one.
  if (indent === "") {
    var rootLeaves = __compactLeaves(group);
    if (rootLeaves) lines.push(rootLeaves);
  }
  for (var i = 1; i <= group.numProperties; i++) {
    var p = group.property(i);
    if (!__isPropertyGroup(p)) continue;
    if (p.matchName === __SHAPE_MATERIALS && !opts.materials) { opts.materialsOmitted += 1; continue; }
    var line = indent + p.name + "  " + __compactKind(p.matchName);
    if (p.matchName === __SHAPE_TRANSFORM && __isIdentityVectorTransform(p)) {
      lines.push(line + "  (at defaults)");
      continue;
    }
    var leaves = __compactLeaves(p);
    lines.push(leaves ? line + "  " + leaves : line);
    if (depth > 0) __compactShapeContents(p, depth - 1, indent + "  ", lines, opts);
    // The leaves are already on the line above, so only unwalked sub-groups
    // are missing — and saying so is the same rule as `childrenOmitted`.
    else if (__hasGroupChild(p)) lines.push(indent + "  (sub-groups not walked — raise shapeDepth)");
  }
  return lines;
}

// The whole `shape` section, with its own omissions named on it.
function __serializeShape(layer, depth, args) {
  var opts = __shapeOpts(args);
  var shape = { depth: depth };
  try {
    var contents = layer.property("Contents");
    if (opts.compact) {
      shape.detail = "compact";
      shape.contents = __compactShapeContents(contents, depth, "", [], opts);
    } else {
      shape.contents = __serializeShapeContents(contents, depth, opts);
    }
  } catch (e) {
    // An unreadable Contents used to leave the section off entirely, which
    // reads as "this shape layer has no shapes".
    shape.error = (e && e.message) ? String(e.message) : String(e);
  }
  if (opts.materialsOmitted > 0) {
    shape.materialsOmitted = opts.materialsOmitted;
    shape.materialsNote = "Material Options omitted on " + opts.materialsOmitted + " shape group" +
      (opts.materialsOmitted === 1 ? "" : "s") + " — 48 3D-extrusion properties each, meaningful only for an " +
      "extruded shape under the Cinema 4D renderer. Pass shapeMaterials:true to read them.";
  }
  return shape;
}

OPS.get_layer_full = noUndo(function (args) {
  var c = getCompById(args.compId);
  var l = getLayerById(c, args.layerId);
  // `include` bounds the response by section, `maxKeyframes` and `shapeDepth`
  // bound the two things that make a single layer weigh 250KB. All three are
  // absent by default, and absent means "everything", exactly as before.
  var want = (args && args.include) ? args.include : null;
  var opts = { maxKeyframes: (args && args.maxKeyframes > 0) ? args.maxKeyframes : 0 };
  var out = {
    id: l.id,
    index: l.index,
    name: l.name,
    enabled: l.enabled,
    solo: l.solo,
    locked: l.locked,
    shy: l.shy,
    threeDLayer: l.threeDLayer,
    label: l.label,
    inPoint: l.inPoint,
    outPoint: l.outPoint,
    startTime: l.startTime,
    stretch: l.stretch,
    blendingMode: String(l.blendingMode),
    preserveTransparency: l.preserveTransparency,
    parent: l.parent ? { layerId: l.parent.id, name: l.parent.name } : null,
    sourceType: __layerKind(l),
  };
  if (__wantsSection(want, "transform")) out.transform = __serializeTransformGroup(l.property("Transform"), opts);
  if (__wantsSection(want, "effects")) out.effects = __serializeEffects(l, opts);
  if (__wantsSection(want, "masks")) out.masks = __serializeMasks(l, opts);
  if (__wantsSection(want, "markers")) out.markers = __serializeMarkers(l);
  // Visual bounds at the comp's current time — cheap to fetch and removes a
  // class of "I need to screenshot to know where this renders" round-trips.
  // Coordinates are in the layer's local space (origin at the Anchor Point).
  if (__wantsSection(want, "bounds")) {
    try {
      var __rect = l.sourceRectAtTime(c.time, false);
      out.sourceRect = { left: __rect.left, top: __rect.top, width: __rect.width, height: __rect.height, time: c.time };
    } catch (__e) {}
  }
  if (l instanceof TextLayer && __wantsSection(want, "text")) out.text = __serializeText(l);
  if (l instanceof ShapeLayer && __wantsSection(want, "shape")) {
    var depth = (args && args.shapeDepth !== undefined && args.shapeDepth !== null) ? args.shapeDepth : 4;
    out.shape = __serializeShape(l, depth, args);
  }
  if (__wantsSection(want, "source")) {
    if (l.source && l.source instanceof CompItem) {
      out.precomp = { compId: l.source.id, compName: l.source.name };
      if (args.includeChildren) {
        out.children = [];
        for (var i = 1; i <= l.source.numLayers; i++) out.children.push(__layerSummary(l.source.layer(i)));
      }
    } else if (l.source && l.source instanceof FootageItem) {
      var src = l.source;
      out.footage = {
        itemId: src.id,
        name: src.name,
        hasAlpha: src.hasAlpha,
        duration: src.duration,
        width: src.width,
        height: src.height,
      };
      try { if (src.file) out.footage.path = src.file.fsName; } catch (e2) {}
    }
  }
  // Echo the scoping back, so a bounded answer is never read as a full one.
  if (want) out.included = want;
  return out;
});


// ---------- high-level scene inspection ----------
// One bounded read used by inspect_scene/review_scene. Keeping this inside one
// dispatch is important: a 60-layer composition should not cost 60 HTTP/MCP
// round-trips just to learn its geometry before one visual review.
function __scenePropertyValue(p, time) {
  if (!p) return null;
  var value = null;
  try { value = p.valueAtTime(time, false); }
  catch (e1) { try { value = p.value; } catch (e2) {} }
  var out = { value: value };
  try { if (p.numKeys > 0) out.keys = p.numKeys; } catch (e3) {}
  try { if (p.canSetExpression && p.expressionEnabled) out.expression = true; } catch (e4) {}
  return out;
}

function __sceneTransform(layer, time) {
  var tg = layer.property("Transform");
  var out = {};
  if (!tg) return out;
  var names = {
    "ADBE Anchor Point": "anchorPoint",
    "ADBE Position": "position",
    "ADBE Scale": "scale",
    "ADBE Opacity": "opacity",
    "ADBE Rotate Z": "rotation",
    "ADBE Orientation": "orientation",
    "ADBE Rotate X": "xRotation",
    "ADBE Rotate Y": "yRotation"
  };
  for (var i = 1; i <= tg.numProperties; i++) {
    var p = tg.property(i);
    var key = names[p.matchName];
    if (key) out[key] = __scenePropertyValue(p, time);
  }
  return out;
}

function __sceneEffects(layer) {
  var fx = layer.property("Effects");
  var out = [];
  if (!fx) return out;
  for (var i = 1; i <= fx.numProperties; i++) {
    var e = fx.property(i);
    var item = { index: i, name: e.name, matchName: e.matchName };
    try { item.enabled = e.enabled; } catch (e1) {}
    try { item.paramCount = e.numProperties; } catch (e2) {}
    out.push(item);
  }
  return out;
}

function __sceneBounds(layer, comp) {
  try {
    var r = layer.sourceRectAtTime(comp.time, false);
    return { left: r.left, top: r.top, width: r.width, height: r.height, time: comp.time };
  } catch (e) { return null; }
}

function __sceneShapePaint(layer) {
  var result = {};
  function walk(group, depth) {
    if (!group || depth < 0 || (result.fill && result.stroke)) return;
    for (var i = 1; i <= group.numProperties; i++) {
      var p = group.property(i);
      if (!p) continue;
      if (!result.fill && p.matchName === "ADBE Vector Graphic - Fill") {
        try { result.fill = p.property("ADBE Vector Fill Color").value; } catch (e1) {}
      }
      if (!result.stroke && p.matchName === "ADBE Vector Graphic - Stroke") {
        try { result.stroke = p.property("ADBE Vector Stroke Color").value; } catch (e2) {}
        try { result.strokeWidth = p.property("ADBE Vector Stroke Width").value; } catch (e3) {}
      }
      try { if (p.numProperties > 0) walk(p, depth - 1); } catch (e4) {}
      if (result.fill && result.stroke) return;
    }
  }
  try { walk(layer.property("Contents"), 4); } catch (e) {}
  return result;
}

function __sceneSource(layer) {
  if (!layer.source) return null;
  if (layer.source instanceof CompItem) {
    return { type: "precomp", compId: layer.source.id, name: layer.source.name, width: layer.source.width, height: layer.source.height };
  }
  if (layer.source instanceof FootageItem) {
    var out = { type: "footage", itemId: layer.source.id, name: layer.source.name, width: layer.source.width, height: layer.source.height, duration: layer.source.duration };
    try { if (layer.source.file) out.path = layer.source.file.fsName; } catch (e) {}
    return out;
  }
  return null;
}

function __sceneLayerSummary(layer, comp) {
  var out = {
    id: layer.id,
    index: layer.index,
    name: layer.name,
    sourceType: __layerKind(layer),
    enabled: layer.enabled,
    solo: layer.solo,
    locked: layer.locked,
    shy: layer.shy,
    threeDLayer: layer.threeDLayer,
    motionBlur: (function () { try { return layer.motionBlur; } catch (e) { return undefined; } })(),
    collapseTransformation: (function () { try { return layer.collapseTransformation; } catch (e) { return undefined; } })(),
    inPoint: layer.inPoint,
    outPoint: layer.outPoint,
    startTime: layer.startTime,
    parent: layer.parent ? layer.parent.id : null,
    transform: __sceneTransform(layer, comp.time),
    bounds: __sceneBounds(layer, comp)
  };
  var effects = __sceneEffects(layer);
  if (effects.length) out.effects = effects;
  if (layer instanceof TextLayer) out.text = __serializeText(layer);
  if (layer instanceof ShapeLayer) {
    var paint = __sceneShapePaint(layer);
    if (paint.fill || paint.stroke) out.paint = paint;
  }
  var source = __sceneSource(layer);
  if (source) out.source = source;
  return out;
}

OPS._inspect_scene = noUndo(function (args) {
  args = args || {};
  var c = null;
  if (args.compId !== undefined && args.compId !== null) c = getCompById(args.compId);
  else if (app.project.activeItem && app.project.activeItem instanceof CompItem) c = app.project.activeItem;
  if (!c) throw new Error("No active composition. Open a comp or pass compId.");

  var maxLayers = (args.maxLayers > 0) ? Math.min(args.maxLayers, 200) : 80;
  var layers = [];
  for (var i = 1; i <= c.numLayers && layers.length < maxLayers; i++) {
    layers.push(__sceneLayerSummary(c.layer(i), c));
  }
  var out = {
    compId: c.id,
    comp: {
      id: c.id, name: c.name, width: c.width, height: c.height, pixelAspect: c.pixelAspect,
      duration: c.duration, frameRate: c.frameRate, time: c.time,
      workAreaStart: c.workAreaStart, workAreaDuration: c.workAreaDuration,
      motionBlur: c.motionBlur, shutterAngle: c.shutterAngle, shutterPhase: c.shutterPhase,
      bgColor: [c.bgColor[0], c.bgColor[1], c.bgColor[2]], numLayers: c.numLayers
    },
    layers: layers,
    layerCount: c.numLayers,
    layersOmitted: Math.max(0, c.numLayers - layers.length),
    detail: args.detail || "summary"
  };

  if (args.includeMotion === true && OPS._comp_motion_map) {
    out.motion = OPS._comp_motion_map({ compId: c.id, maxTimes: args.motionMaxTimes || 120 });
  }

  if (args.detail && args.detail !== "summary") {
    var ids = args.layerIds || [];
    if (!ids.length) {
      var cap = args.detail === "full" ? 24 : 12;
      for (var j = 0; j < layers.length && j < cap; j++) ids.push(layers[j].id);
    }
    var details = [];
    for (var k = 0; k < ids.length; k++) {
      details.push(OPS.get_layer_full({
        compId: c.id,
        layerId: ids[k],
        include: args.include || ["transform", "text", "effects", "source", "bounds"],
        maxKeyframes: args.maxKeyframes || 12,
        shapeDepth: (args.shapeDepth !== undefined ? args.shapeDepth : 2),
        shapeDetail: "compact"
      }));
    }
    out.layerDetails = details;
    out.detailLayers = details.length;
    if (!args.layerIds && args.detail === "full" && layers.length > details.length) {
      out.detailLayersOmitted = layers.length - details.length;
      out.note = "Full detail is capped at 24 layers; pass layerIds for additional layers.";
    }
  }
  return out;
});

// Project item kind. An if/else chain, not a chained ternary: this build of
// ExtendScript parses `a ? x : b ? y : z` left-associatively, so the first
// truthy branch became the next condition and every item fell through to
// "folder" (issues #21/#22). tests/unit/jsx-ternary.mjs keeps it that way.
// "solid" mirrors __layerKind in layers.jsx so an item and a layer that share a
// source describe it with the same word.
function __itemKind(it) {
  if (it instanceof CompItem) return "comp";
  if (it instanceof FolderItem) return "folder";
  if (it instanceof FootageItem) {
    try {
      if (it.mainSource && it.mainSource.color !== undefined) return "solid";
    } catch (e) {}
    return "footage";
  }
  return "unknown";
}

OPS.get_project_summary = noUndo(function (args) {
  var p = app.project;
  var items = [];
  for (var i = 1; i <= p.numItems; i++) {
    var it = p.item(i);
    items.push({
      id: it.id,
      name: it.name,
      type: __itemKind(it),
    });
  }
  return {
    path: p.file ? p.file.fsName : null,
    numItems: p.numItems,
    activeItemId: p.activeItem ? p.activeItem.id : null,
    items: items,
  };
});

// A search, so the default is the opposite of list_layers: absent `include`
// means the core alone — id/index/name/sourceType plus the comp — because the
// reason to call this is to learn which layers exist and what to address them
// by, not to read them (issue #87: nine matches cost ~2k tokens, re-sent on
// every later request). `include: []` and omitting it are therefore the same
// here, and the section names are list_layers' own, read through the same
// __layerSummary. What was included is echoed, so a bounded answer is never
// read as a full one.
OPS.find_layers = noUndo(function (args) {
  var sections = (args && args.include) ? args.include : [];
  var out = [];
  var comps = [];
  if (args.compId) comps.push(getCompById(args.compId));
  else {
    for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      if (it instanceof CompItem) comps.push(it);
    }
  }
  var pat = args.namePattern ? new RegExp(args.namePattern, "i") : null;
  for (var ci = 0; ci < comps.length; ci++) {
    var c = comps[ci];
    for (var li = 1; li <= c.numLayers; li++) {
      var l = c.layer(li);
      if (pat && !pat.test(l.name)) continue;
      if (args.type && __layerKind(l) !== args.type) continue;
      if (args.hasEffectMatchName) {
        var fx = l.property("Effects");
        var hit = false;
        if (fx) {
          for (var fi = 1; fi <= fx.numProperties; fi++) {
            if (fx.property(fi).matchName === args.hasEffectMatchName) { hit = true; break; }
          }
        }
        if (!hit) continue;
      }
      var s = __layerSummary(l, sections);
      s.compId = c.id;
      s.compName = c.name;
      out.push(s);
    }
  }
  return { matches: out, count: out.length, compsSearched: comps.length, included: sections };
});
