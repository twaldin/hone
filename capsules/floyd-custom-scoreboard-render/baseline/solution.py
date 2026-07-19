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
    glyphs = []
    colors = []
    visual_index = 0
    for run in field["runs"]:
        color = run["color"]
        for char in run["text"]:
            glyphs.append(_normalized(char))
            colors.append(forced_colors[visual_index] if forced_colors is not None else color)
            visual_index += 1
    if not glyphs:
        return []
    segments = []
    current = []
    current_color = colors[0]
    for index, glyph in enumerate(glyphs):
        if current and colors[index] != current_color:
            segments.append(["".join(current), current_color])
            current = []
        current_color = colors[index]
        current.append(glyph)
    if current:
        segments.append(["".join(current), current_color])
    return segments

def _width(segments, advances):
    width = 0.0
    for text, _color in segments:
        for char in text:
            width += advances.get(char, advances["?"])
    return width

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
    radii = [radius, radius, radius, radius]
    commands = []
    if panel["blur"]:
        blur_radius = _rounded(min(20, max(0, panel["blurStrength"])) * 0.4)
        if blur_radius >= 0.5 and fw * fh >= 2000.0:
            commands.append({"op": "blur", "rect": rect, "radii": radii, "strength": blur_radius, "box": panel["blurBox"]})
            commands.append({"op": "bind-main-fbo"})
    fill = panel["fill"]
    commands.append({
        "op": "round-rect", "rect": rect, "fill": [fill, fill, fill, fill],
        "radii": radii, "border": panel["border"], "outline": outline,
    })
    for segments, x, y in texts:
        commands.append({
            "op": "text", "at": [_rounded(fx + x * scale), _rounded(fy + y * scale)],
            "scale": scale, "segments": segments,
        })
        commands.append({"op": "flush-text"})
        commands.append({"op": "bind-main-fbo"})
    return {"layout": {"width": box_width, "height": box_height}, "commands": commands}

def _layout(value, lines):
    advances = value["advances"]
    panel = value["panel"]
    title = _styled(value["title"])
    brand = _styled(value["brand"], panel["brandAccents"])
    title_width = _width(title, advances)
    brand_width = _width(brand, advances)
    max_width = max(title_width, brand_width)
    for _segments, name_width in lines:
        max_width = max(max_width, name_width)
    padding = max(0, panel["padding"])
    box_width = math.ceil(max_width + padding * 2)
    title_y = padding + 2
    header_height = title_y + 10 + 2
    brand_y = header_height + len(lines) * 10 + 2
    box_height = brand_y + 10 + padding
    texts = [(title, (box_width - title_width) / 2.0, float(title_y))]
    line_y = header_height
    for segments, _name_width in lines:
        texts.append((segments, float(padding), float(line_y)))
        line_y += 10
    texts.append((brand, (box_width - brand_width) / 2.0, float(brand_y)))
    return box_width, box_height, texts

def solve(value):
    rendered = None
    for _frame in range(value["frameReps"]):
        entries = [entry for entry in value["entries"] if not entry["hidden"]]
        entries.sort(key=lambda entry: (-entry["value"], entry["owner"].lower()))
        entries = entries[:15]
        if not entries:
            rendered = None
            continue
        lines = []
        for entry in entries:
            name = _styled(entry["name"])
            score = _styled(entry["score"])
            name_width = _width(name, value["advances"])
            score_width = _width(score, value["advances"])
            if score_width < 0:
                raise AssertionError("unreachable")
            lines.append((name, name_width))
        rendered = _draw(_layout(value, lines), value["panel"])
    return rendered
