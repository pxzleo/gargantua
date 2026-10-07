#!/usr/bin/env python3
"""Synthesises the original ambient loop used by GARGANTUA.

Pure numpy additive synthesis: an organ-like pad progressing through four
chords, a sub-bass drone, slow shimmer partials and filtered "solar wind"
noise. The tail is cross-faded into the head so the file loops seamlessly.

usage: python3 tools/make_audio.py  ->  assets/audio/gargantua-ambient.{wav,ogg,mp3}
"""
import os
import subprocess
import wave

import numpy as np

SR = 44100
LOOP = 64.0          # seconds of the final loop
XF = 4.0             # cross-fade seconds
TOTAL = LOOP + XF
rng = np.random.default_rng(7)
t = np.arange(int(SR * TOTAL)) / SR


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


# D minor-ish progression, voiced low and wide (original, slow-moving)
CHORDS = [
    [38, 45, 50, 53, 57, 62],      # Dm(add9 colour via upper voices)
    [34, 41, 46, 50, 53, 58],      # Bb
    [36, 43, 48, 52, 55, 60],      # C
    [33, 40, 45, 49, 52, 57],      # A
]
SEG = LOOP / len(CHORDS)


def chord_weight(i, tt):
    """Smooth periodic window for chord i (raised cosine, overlapping)."""
    centre = (i + 0.5) * SEG
    d = ((tt - centre + LOOP / 2) % LOOP) - LOOP / 2
    w = np.clip(1 - np.abs(d) / (SEG * 0.95), 0, 1)
    return 0.5 - 0.5 * np.cos(np.pi * w)


def organ(freq, tt, phase):
    # additive organ: fundamental + octave + fifth + 2 octaves, slight chorus
    out = np.zeros_like(tt)
    for mult, amp in [(1, 1.0), (2, 0.45), (3, 0.18), (4, 0.12), (6, 0.04)]:
        for det in (-0.12, 0.12):
            f = freq * mult * (1 + det / 1200 * 10)
            out += amp * np.sin(2 * np.pi * f * tt + phase * mult)
    return out / 4.0


left = np.zeros_like(t)
right = np.zeros_like(t)

for ci, chord in enumerate(CHORDS):
    w = chord_weight(ci, t % LOOP)
    for vi, n in enumerate(chord):
        f = midi(n)
        ph = rng.uniform(0, 2 * np.pi)
        trem = 1 + 0.08 * np.sin(2 * np.pi * (0.07 + 0.013 * vi) * t + ph)
        sig = organ(f, t, ph) * trem * (0.9 if vi < 2 else 0.55)
        pan = 0.5 + 0.35 * np.sin(vi * 1.7)
        left += sig * w * (1 - pan)
        right += sig * w * pan

# sub drone on D (and A fifth), breathing slowly
sub = 0.55 * np.sin(2 * np.pi * midi(26) * t) + 0.25 * np.sin(2 * np.pi * midi(33) * t)
sub *= 0.75 + 0.25 * np.sin(2 * np.pi * t / 16.0)
left += sub
right += sub

# high shimmer partials with slow glints
for k, n in enumerate([74, 81, 86, 89]):
    env = np.clip(np.sin(2 * np.pi * (t / 32.0 + k * 0.23)), 0, 1) ** 3
    s = 0.06 * np.sin(2 * np.pi * midi(n) * t + k) * env
    left += s * (0.3 + 0.2 * k)
    right += s * (1.0 - 0.2 * k)


# filtered noise wind (one-pole low-pass sweep, done in blocks)
def wind(seed):
    r = np.random.default_rng(seed)
    n = r.standard_normal(len(t))
    out = np.empty_like(n)
    y = 0.0
    cut = 0.004 + 0.003 * (1 + np.sin(2 * np.pi * t / 21.0 + seed))
    for i in range(len(n)):
        y += cut[i] * (n[i] - y)
        out[i] = y
    return out * 0.9


left += wind(1)
right += wind(2)

# simple feedback "space" (multi-tap delay) for depth
def space(x):
    y = x.copy()
    for d, g in [(0.113, 0.33), (0.247, 0.26), (0.389, 0.21), (0.571, 0.16), (0.83, 0.11)]:
        k = int(d * SR)
        y[k:] += g * x[:-k]
    return y


left, right = space(left), space(right)

# loop: cross-fade tail into head
n_loop, n_xf = int(LOOP * SR), int(XF * SR)
fade = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, n_xf))
for ch in (left, right):
    ch[:n_xf] = ch[:n_xf] * fade + ch[n_loop:n_loop + n_xf] * (1 - fade)
left, right = left[:n_loop], right[:n_loop]

st = np.stack([left, right], axis=1)
st /= np.max(np.abs(st)) / 0.82
st = np.tanh(st * 1.1) / np.tanh(1.1)

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "audio")
os.makedirs(root, exist_ok=True)
wav = os.path.join(root, "gargantua-ambient.wav")
with wave.open(wav, "wb") as f:
    f.setnchannels(2)
    f.setsampwidth(2)
    f.setframerate(SR)
    f.writeframes((st * 32767).astype("<i2").tobytes())

subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-c:a", "libvorbis", "-q:a", "5",
                os.path.join(root, "gargantua-ambient.ogg")], check=True)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-c:a", "libmp3lame", "-b:a", "160k",
                os.path.join(root, "gargantua-ambient.mp3")], check=True)
os.remove(wav)
print("ok")
