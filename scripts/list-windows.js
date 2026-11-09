// Dev probe: lists on-screen windows with layer <= 0 (desktop widgets, our widget) as JSON.
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var ref = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID);
var arr = ObjC.castRefToObject(ref);
var n = arr.count;
var out = [];
for (var i = 0; i < n; i++) {
  var d = ObjC.deepUnwrap(arr.objectAtIndex(i)) || {};
  if (d.kCGWindowLayer > 0) continue;
  out.push({ owner: d.kCGWindowOwnerName, name: d.kCGWindowName, layer: d.kCGWindowLayer, b: d.kCGWindowBounds, pid: d.kCGWindowOwnerPID });
}
JSON.stringify(out);
