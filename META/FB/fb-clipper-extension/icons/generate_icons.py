from PIL import Image, ImageDraw
import os

SIZE = 512
BG = (24, 119, 242, 255)  # Facebook blue
WHITE = (255, 255, 255, 255)

HERE = os.path.dirname(os.path.abspath(__file__))


def make_base():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=100, fill=BG)
    return img


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
