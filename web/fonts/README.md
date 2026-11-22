# Bitmap fonts

The editor bundles X11 misc-fixed Unicode bitmap faces Fixed 6×13
(medium semicondensed), Fixed Bold 7×14, and Fixed 10×20 (medium), plus
Terminus 8×16 (medium), a different bitmap family. These are native cell
sizes, not resized versions of one font. Each cell advances by its full width; a scale of N displays each
source pixel as an N×N square, without smoothing. The cells include the
original ascent, descent and spacing.

The misc-fixed BDF files and accompanying upstream `README` come from Markus
Kuhn's original [Unicode X11 font collection](https://www.cl.cam.ac.uk/~mgk25/ucs-fonts.html),
[ucs-fonts.tar.gz](https://www.cl.cam.ac.uk/~mgk25/download/ucs-fonts.tar.gz).
Each selected BDF declares `COPYRIGHT "Public domain font.  Share and
 enjoy."`; the upstream README also states contributions remain public
domain. The original files and notices are retained here.

Terminus 8×16 is the unmodified `ter-u16n.bdf` from Dimitar Toshkov
Zhekov's [Terminus Font 4.49.1](https://terminus-font.sourceforge.net/),
downloaded from the author's [source archive](https://downloads.sourceforge.net/project/terminus-font/terminus-font-4.49/terminus-font-4.49.1.tar.gz).
Copyright © 2020 Dimitar Toshkov Zhekov. The font is licensed under the
SIL Open Font License 1.1; the complete license is in `OFL.TXT`, and
the upstream contributor list is in `AUTHORS`.

Run `node tools/generate_fonts.js` from the repository root to regenerate
`web/fonts.js`. The converter preserves encoded Unicode glyphs that fit
the fixed cells and skips control characters and invalid Unicode scalar
values. Coverage varies by face; no glyph is invented for missing code
points. The editor must signal unsupported characters and draw its own
missing-glyph indicator rather than substituting another font.
