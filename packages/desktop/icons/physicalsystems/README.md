# Physical Systems workcell icon

The approved workcell artwork is the Physical Systems app mark. `source.png`
preserves the original transparent image; it is not shipped in the app resource
folder. The icon contains no wordmark, background tile, or partner branding.

Regenerate the PNG, Windows ICO, and macOS ICNS exports from the desktop package:

```sh
python scripts/export-brand-icons.py
```

This requires Pillow 10.4 or newer. Exports trim excess transparent margins and
fit the artwork inside a square with 4% padding. ICO contains 16, 24, 32, 48, 64,
128, and 256 pixel frames. All exports retain alpha transparency.

Physical Systems public, candidate, and review packaging copy these icons into
the installed `resources/icons` folder, also used by the window and macOS Dock.
Windows public/candidate installers embed `icon.ico`; release/signing policy is
unchanged. Review builds keep executable resource editing disabled by their
existing policy, so their executable file icon may remain Electron's even though
the running window uses the new mark. Existing published installers are not
changed until a newly qualified release is built and published.
