from PIL import Image, ImageDraw
import os

SIZE = 512
# Instagram's classic gradient corners, approximated
TOP_LEFT = (64, 93, 230, 255)      # blue-purple
BOTTOM_LEFT = (131, 58, 180, 255)  # purple
CENTER = (193, 53, 132, 255)       # magenta
TOP_RIGHT = (253, 29, 29, 255)     # red
BOTTOM_RIGHT = (247, 119, 55, 255)  # orange
WHITE = (255, 255, 255, 255)

HERE = os.path.dirname(os.path.abspath(__file__))


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(4))


def make_gradient():
    # Diagonal gradient from bottom-left (purple) to top-right (orange/red),
    # approximating Instagram's brand gradient.
    grad = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    px = grad.load()
    for y in range(SIZE):
        for x in range(SIZE):
            t = (x + (SIZE - y)) / (2 * SIZE)  # 0 at bottom-left, 1 at top-right
            if t < 0.5:
                color = lerp(BOTTOM_LEFT, CENTER, t * 2)
            else:
                color = lerp(CENTER, TOP_RIGHT, (t - 0.5) * 2)
            px[x, y] = color
    return grad


def make_base():
    mask = Image.new("L", (SIZE, SIZE), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=100, fill=255)
    grad = make_gradient()
    base = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    base.paste(grad, (0, 0), mask)
    return base


def make_clip_layer():
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    stroke = 34
    outer_box = [150, 80, 300, 380]
    d.rounded_rectangle(outer_box, radius=75, outline=WHITE, width=stroke)
    inner_box = [178, 132, 272, 380]
    d.rounded_rectangle(inner_box, radius=47, outline=WHITE, width=stroke)
    layer = layer.rotate(-35, resample=Image.BICUBIC, center=(SIZE / 2, SIZE / 2))
    return layer


base = make_base()
clip = make_clip_layer()
final = Image.alpha_composite(base, clip)

for s in (16, 32, 48, 128):
    final.resize((s, s), Image.LANCZOS).save(os.path.join(HERE, f"icon{s}.png"))

print("done")
