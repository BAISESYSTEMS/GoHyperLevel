# Office: third-party software (attribution and licenses)

HyperLevel's Office area (documents, spreadsheets, presentations, PDF – [docs/office.md](../../docs/office.md)) can use four
open-source programs from the same upstream team: each as a browser editor (a static WebAssembly site) and as a headless
command-line engine. **None of their code is part of HyperLevel's repository or of HyperLevel's own Docker image.** They are
downloaded from the upstream GitHub releases by [install.sh](install.sh) (pinned versions and checksums in
[versions.env](versions.env)) or built into the optional image of this folder ([Dockerfile](Dockerfile)), and HyperLevel talks to
them only through files, command lines and the browser (postMessage) – they stay separate programs under their own licenses.

| In HyperLevel | Upstream project | Version | Source | License |
|---|---|---|---|---|
| Dokumente (.docx) | WordCraft | 0.3.0 | <https://github.com/storytold/wordcraft> | MIT OR Apache-2.0 |
| Tabellen (.xlsx) | GridCraft | 0.3.0 | <https://github.com/storytold/gridcraft> | MIT OR Apache-2.0 |
| Präsentationen (.pptx) | DeckCraft | 0.3.0 | <https://github.com/storytold/deckcraft> | MIT OR Apache-2.0 |
| PDF | PdfCraft | 0.4.0 | <https://github.com/storytold/pdfcraft> | MIT OR Apache-2.0 |

Copyright (c) 2026 ArtCraft Team and the WordCraft, GridCraft, DeckCraft and PdfCraft contributors. Each project is
dual-licensed under the MIT License or the Apache License, Version 2.0, at your option; the license files (`LICENSE-MIT`,
`LICENSE-APACHE`) ship inside every release and are kept by install.sh next to the installed files (the editor folders and
`<bin dir>/licenses/<kind>/`). Their required notices are in each project's `NOTICE` file. Fonts, icons and other assets bundled
in the releases keep their own open licenses (mostly SIL Open Font License 1.1 – the `OFL-*.txt` files in the editor folders;
the full list is each project's `ATTRIBUTION.md`).

`patches/gridcraft-0001-wasm-instant.patch` is a change to GridCraft's source for building its browser editor yourself
([build-from-source.sh](build-from-source.sh)); it is offered under the same terms as GridCraft (MIT OR Apache-2.0).

## Trademarks

"ArtCraft" and the names and logos of the Crafting Apps (WordCraft, GridCraft, DeckCraft, PdfCraft …) are trademarks of the
ArtCraft Team and are **not** covered by the software licenses above. HyperLevel therefore uses neutral names in its interface and
documentation (Dokumente, Tabellen, Präsentationen, PDF) and does not use the upstream logos. The unmodified editors may show
their own name inside the editor frame; that is the upstream program as published. HyperLevel is not affiliated with, sponsored or
endorsed by the ArtCraft Team. "Microsoft", "Word", "Excel", "PowerPoint" and "Adobe Acrobat" are trademarks of their owners;
the file formats are named only to describe compatibility.

## MIT License (the text of each project's `LICENSE-MIT`)

```
MIT License

Copyright (c) 2026 ArtCraft Team and the <WordCraft | GridCraft | DeckCraft | PdfCraft> contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The Apache License, Version 2.0 is at <https://www.apache.org/licenses/LICENSE-2.0> and in each release's `LICENSE-APACHE`.
