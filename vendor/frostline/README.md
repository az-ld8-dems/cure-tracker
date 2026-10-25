# Frostline (vendored)

A verbatim copy of three files of avi.me's Frostline design system, version in `VERSION`: `components/bundle.css`, `components/bundle.ts` (compiled by `tools/build.sh`) and `components/index.d.ts`, plus its `tsconfig.json`. Source: `packages/frostline/` in the avi.me repository.

Do not edit these files here. A fix belongs in avi.me's Frostline (see its `GUIDELINES.md`: "Fix in Frostline"), then copy the files again and bump `VERSION`:

```bash
F=~/repos/avi.me/packages/frostline
cp $F/components/bundle.css $F/components/bundle.ts $F/components/index.d.ts vendor/frostline/components/
cp $F/tsconfig.json $F/VERSION vendor/frostline/
```

Only the components and their behavior are used. Frostline's own tokens (`tokens.css`, the Nord palette, IBM Plex) are not shipped: `public/tokens.css` maps the token names its components read onto the LD8 design system's values (`docs/design.md`).
