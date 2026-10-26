// a place or a surface's name as one name in the graph: it may hold "/" (a place is a path)
export const enc = (s: string) => encodeURIComponent(s)
export const dec = (s: string) => decodeURIComponent(s)
// the place of a name under a place
export const kid = (p: string, name: string) => (p === "/" ? "" : p) + "/" + name
// a value written whole
export const whole = (value: unknown) => [{ path: [], value }]
