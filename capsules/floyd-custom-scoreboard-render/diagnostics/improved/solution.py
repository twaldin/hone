import heapq
import math
import unicodedata

_SMALL_CAPS = {
    "ᴀ": "A", "ʙ": "B", "ᴄ": "C", "ᴅ": "D", "ᴇ": "E", "ꜰ": "F",
    "ɢ": "G", "ʜ": "H", "ɪ": "I", "ᴊ": "J", "ᴋ": "K", "ʟ": "L",
    "ᴍ": "M", "ɴ": "N", "ᴏ": "O", "ᴘ": "P", "ꞯ": "Q", "ʀ": "R",
    "ꜱ": "S", "ᴛ": "T", "ᴜ": "U", "ᴠ": "V", "ᴡ": "W", "ʏ": "Y", "ᴢ": "Z",
}

def _normalized(char):
    code = ord(char)
    if 0x20 <= code <= 0x7e:
        return char
    mapped = _SMALL_CAPS.get(char)
    if mapped is not None:
        return mapped
    normalized = unicodedata.normalize("NFKC", char)
    if normalized and all(0x20 <= ord(item) <= 0x7e for item in normalized):
        return normalized
    return char

def _styled(field, forced_colors=None):
    segments = []
    current = []
    current_color = None
    visual_index = 0
    for run in field["runs"]:
        for char in run["text"]:
            color = forced_colors[visual_index] if forced_colors is not None else run["color"]
            visual_index += 1
            if current and color != current_color:
                segments.append(["".join(current), current_color])
                current = []
            current_color = color
            current.append(_normalized(char))
    if current:
        segments.append(["".join(current), current_color])
    return segments

def _width(segments, advances):
    return sum(advances.get(char, advances["?"]) for text, _color in segments for char in text)

def _rounded(value):
    return round(float(value), 4)

def _draw(layout, panel):
    box_width, box_height, texts = layout
    scale = panel["scale"]
    fx = float(panel["x"])
    fy = float(panel["y"])
    fw = _rounded(box_width * scale)
    fh = _rounded(box_height * scale)
    radius = _rounded(panel["cornerRadius"] * scale)
    outline = _rounded(panel["borderWidth"] * scale)
    rect = [fx, fy, fw, fh]
    radii = [radius] * 4
    commands = []
    if panel["blur"]:
        blur_radius = _rounded(min(20, max(0, panel["blurStrength"])) * 0.4)
        if blur_radius >= 0.5 and fw * fh >= 2000.0:
            commands.extend((
                {"op": "blur", "rect": rect, "radii": radii, "strength": blur_radius, "box": panel["blurBox"]},
                {"op": "bind-main-fbo"},
            ))
    fill = panel["fill"]
    commands.append({"op": "round-rect", "rect": rect, "fill": [fill] * 4, "radii": radii, "border": panel["border"], "outline": outline})
    for segments, x, y in texts:
        commands.extend((
            {"op": "text", "at": [_rounded(fx + x * scale), _rounded(fy + y * scale)], "scale": scale, "segments": segments},
            {"op": "flush-text"},
            {"op": "bind-main-fbo"},
        ))
    return {"layout": {"width": box_width, "height": box_height}, "commands": commands}

_STYLE_CACHE = {}

def _styled_cached(field, advances, forced_colors=None):
    key = id(field)
    hit = _STYLE_CACHE.get(key)
    if hit is None:
        segments = _styled(field, forced_colors)
        hit = (segments, _width(segments, advances))
        _STYLE_CACHE[key] = hit
    return hit

def _layout(value, lines):
    advances = value["advances"]
    panel = value["panel"]
    title, title_width = _styled_cached(value["title"], advances)
    brand, brand_width = _styled_cached(value["brand"], advances, panel["brandAccents"])
    max_width = max([title_width, brand_width] + [name_width for _segments, name_width in lines])
    padding = max(0, panel["padding"])
    box_width = math.ceil(max_width + padding * 2)
    title_y = padding + 2
    header_height = title_y + 12
    brand_y = header_height + len(lines) * 10 + 2
    box_height = brand_y + 10 + padding
    texts = [(title, (box_width - title_width) / 2.0, float(title_y))]
    texts.extend((segments, float(padding), float(header_height + index * 10)) for index, (segments, _width_value) in enumerate(lines))
    texts.append((brand, (box_width - brand_width) / 2.0, float(brand_y)))
    return box_width, box_height, texts

def solve(value):
    advances = value["advances"]
    visible = [entry for entry in value["entries"] if not entry["hidden"]]
    if not visible:
        return None
    if len(visible) > 15:
        cutoff = heapq.nlargest(15, [entry["value"] for entry in visible])[-1]
        visible = [entry for entry in visible if entry["value"] >= cutoff]
    visible.sort(key=lambda entry: (-entry["value"], entry["owner"].lower()))
    lines = [_styled_cached(entry["name"], advances) for entry in visible[:15]]
    return _draw(_layout(value, lines), value["panel"])
