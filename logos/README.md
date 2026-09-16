# Sponsor / partner logos

Drop white PNG logos here and they appear automatically in the strip **below the hero**
(the "Presented in community with" row). No code changes needed.

## How it works
The strip tries to load `logos/<file>.png` for each sponsor. Until a file exists, that
sponsor falls back to a gold text name. Add the PNG → it replaces the text on next load.
Order is controlled by the `SPONSORS` array in `index.html` (already set to the flyer order).

## Specs
- **Format:** PNG, transparent background
- **Color:** white (the strip sits on a dark band in both light & dark themes)
- **Height:** export at ~120 px tall (displayed at 34 px; extra res keeps it crisp on retina)
- **Padding:** trim tight; a little internal breathing room is fine
- **Naming:** lowercase, hyphenated — must match the filenames below exactly

## Expected files (in display order)
| # | Sponsor | Filename |
|---|---------|----------|
| 1 | SEDETUR | `sedetur.png` |
| 2 | Holistika Tulum | `holistika.png` |
| 3 | Vesica | `vesica.png` |
| 4 | Kan Tulum | `kan-tulum.png` |
| 5 | Ahau Tulum | `ahau-tulum.png` |
| 6 | The Space | `the-space.png` |
| 7 | Shakti Temple | `shakti-temple.png` |
| 8 | Lokäh | `lokah.png` |
| 9 | Vikingos Fit Club | `vikingos-fit-club.png` |
| 10 | Tulum Despierta | `tulum-despierta.png` |
| 11 | Azulik | `azulik.png` |
| 12 | Oasis Tulum | `oasis-tulum.png` |

## Adding, removing, or reordering sponsors
Edit the `SPONSORS` array in `index.html` — each entry is `{name:'Display Name', file:'filename-without-extension'}`.
The same list also powers the "Thank You" sponsor grid near the footer.
