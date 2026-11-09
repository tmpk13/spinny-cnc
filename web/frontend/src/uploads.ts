// The files the backend reads, by suffix, so the file dialogs offer every
// one of them: a board layer's gerber however kicad-cli named it, and gcode.

/** A board layer's gerber: KiCad's own suffix and the Protel ones kicad-cli gives the copper, mask, paste, silk and outline layers, as the backend's board module lists them. */
export const GERBER_SUFFIXES = [".gbr", ".gtl", ".gbl", ".gts", ".gbs", ".gtp", ".gbp", ".gto", ".gbo", ".gm1"];

/** X/Y gcode. */
export const GCODE_SUFFIXES = [".gcode", ".nc", ".ngc"];
