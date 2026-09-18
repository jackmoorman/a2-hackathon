// Sample utility GIS features, expressed as LOCAL OFFSETS in meters from the
// GPS origin captured at launch. This keeps the demo controllable while
// guaranteeing features appear wherever you are standing.
//
//   east  : meters east of origin (+) / west (-)
//   north : meters north of origin (+) / south (-)
//
// Lines are lists of {east, north} vertices. Points are single locations.
// `depth` is meters below ground (used later for label callouts).

window.UTILITIES = {
  lines: [
    {
      id: "w-main-1",
      type: "water",
      label: "12\" Water Main",
      depth: 1.2,
      path: [
        { east: -40, north: 12 },
        { east: 40, north: 12 },
      ],
    },
    {
      id: "g-main-1",
      type: "gas",
      label: "6\" Gas Main",
      depth: 0.9,
      path: [
        { east: -6, north: 40 },
        { east: -6, north: -20 },
      ],
    },
    {
      id: "e-duct-1",
      type: "electric",
      label: "Electric Duct Bank",
      depth: 0.7,
      path: [
        { east: -40, north: 6 },
        { east: 0, north: 6 },
        { east: 8, north: 40 },
      ],
    },
  ],
  points: [
    { id: "mh-1", type: "manhole", label: "Sanitary MH", depth: 3.0, east: 10, north: 12 },
    { id: "v-1", type: "valve", label: "Gate Valve", depth: 1.2, east: -6, north: 12 },
    { id: "h-1", type: "hydrant", label: "Hydrant", depth: 0, east: 18, north: 8 },
  ],
};
