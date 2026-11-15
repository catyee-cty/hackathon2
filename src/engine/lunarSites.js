/**
 * Database of Lunar Landing Sites: Artemis Candidates, South Pole PSRs, and Historic Landmarks.
 */

export const LUNAR_SITES = [
  {
    id: "shackleton",
    name: "Shackleton Crater Rim",
    subtitle: "Artemis III Primary Candidate &bull; South Pole",
    lat: -89.9,
    lon: 0.0,
    elevation: 1250, // relative to reference datum
    targetOffset: [0.0, 0.0],
    craterRadius: 21.0, // km
    peakIllumPct: 86.4,
    avgSlope: 4.8,
    type: "Artemis III Zone",
    description: "Located almost precisely at the lunar South Pole. The peaks along the rim receive near-permanent solar illumination (>86% of the lunar year), while the deep interior (-4.2 km) contains Permanently Shadowed Regions (PSRs) harboring billions of tons of water ice.",
    features: ["Permanent Sunlight Ridge", "Direct Earth Comm Line-of-Sight", "Volatile Cryo-Traps"]
  },
  {
    id: "malapert",
    name: "Malapert Mountain (Massif)",
    subtitle: "Connecting Ridge &bull; 86.0°S, 2.7°E",
    lat: -86.0,
    lon: 2.7,
    elevation: 5040,
    targetOffset: [0.35, -0.2],
    craterRadius: 35.0,
    peakIllumPct: 93.2,
    avgSlope: 7.2,
    type: "Solar Power Base",
    description: "A prominent 5,000-meter peak near the South Pole. Its towering altitude offers uninterrupted line-of-sight to Earth for deep space communications and near-continuous sunlight for continuous photovoltaic base operation.",
    features: ["Towering High Relief", "Unbroken Earth Visibility", "Relay Communications Hub"]
  },
  {
    id: "nobile",
    name: "Nobile Crater Rim 1",
    subtitle: "VIPER Mission Target &bull; 85.2°S, 53.5°E",
    lat: -85.2,
    lon: 53.5,
    elevation: -1800,
    targetOffset: [-0.4, 0.3],
    craterRadius: 73.0,
    peakIllumPct: 78.5,
    avgSlope: 5.1,
    type: "Volatiles Prospecting",
    description: "Formed through a colossal ancient impact. The terrain features rolling hills interspersed with ultra-cold shadowed micro-craters ideal for rover neutron spectrometer and drill sampling.",
    features: ["Micro-cold traps", "Gentle Rover Incline", "Subsurface Ice Rich"]
  },
  {
    id: "apollo11",
    name: "Apollo 11 &bull; Mare Tranquillitatis",
    subtitle: "Historic First Landing &bull; 0.67°N, 23.47°E",
    lat: 0.67,
    lon: 23.47,
    elevation: -1200,
    targetOffset: [0.1, 0.5],
    craterRadius: 15.0,
    peakIllumPct: 50.0,
    avgSlope: 1.8,
    type: "Historic Site",
    description: "Statio Tranquillitatis. A vast basaltic mare surface covered in fine, dark titanium-rich regolith with low slopes, minor boulder fields (West Crater hazard), and smooth lunar plains.",
    features: ["Apollo Lunar Surface Journal", "Low Slope Basalt Plains", "Solar Diurnal Cycle (14d light/dark)"]
  },
  {
    id: "aristarchus",
    name: "Aristarchus Plateau",
    subtitle: "Pyroclastic Deposits &bull; 23.7°N, 47.4°W",
    lat: 23.7,
    lon: -47.4,
    elevation: 2800,
    targetOffset: [-0.3, -0.4],
    craterRadius: 40.0,
    peakIllumPct: 50.0,
    avgSlope: 12.4,
    type: "Volcanic Science",
    description: "The brightest large formation on the Moon. Famous for high radar reflectivity, radon gas outgassing events, and Vallis Schröteri — the largest sinuous rille on the lunar surface.",
    features: ["Extreme Albedo Anomaly", "Giant Sinuous Lava Tube Rille", "Pyroclastic Glass Deposits"]
  },
  {
    id: "tycho",
    name: "Tycho Crater Central Peak",
    subtitle: "Prominent Impact Ray System &bull; 43.3°S, 11.2°W",
    lat: -43.3,
    lon: -11.2,
    elevation: -4800,
    targetOffset: [0.2, -0.3],
    craterRadius: 85.0,
    peakIllumPct: 50.0,
    avgSlope: 18.2,
    type: "Impact Geophysics",
    description: "A spectacularly young 108-million-year-old impact crater. Spectacular 1,600-meter central mountain peak with impact melt sheets and massive boulder fields.",
    features: ["1,500km Ejecta Rays", "Towering Central Peak", "Exposed Deep Crustal Rocks"]
  },
  {
    id: "aitken",
    name: "South Pole - Aitken Basin (Far Side)",
    subtitle: "Deepest Impact Basin &bull; 53.0°S, 169.0°W",
    lat: -53.0,
    lon: -169.0,
    elevation: -8200,
    targetOffset: [0.0, 0.0],
    craterRadius: 120.0,
    peakIllumPct: 50.0,
    avgSlope: 6.8,
    type: "Planetary Giant",
    description: "One of the largest known impact craters in the Solar System (2,500 km across, 8 km deep) on the lunar Far Side. Exposes mantle-derived rocks and massive mantle uplift.",
    features: ["Deepest Lunar Basin", "Lunar Far Side Target", "Mantle Material Exposure"]
  },
  {
    id: "procellarum",
    name: "Oceanus Procellarum &bull; Apollo 12",
    subtitle: "Ocean of Storms &bull; 3.01°S, 23.42°W",
    lat: -3.01,
    lon: -23.42,
    elevation: -2400,
    targetOffset: [0.2, 0.2],
    craterRadius: 30.0,
    peakIllumPct: 50.0,
    avgSlope: 2.1,
    type: "Historic Basalt",
    description: "The vast western lunar mare covering over 4 million square kilometers. Visited by Apollo 12 near Surveyor III robot probe.",
    features: ["Giant Basalt Plain", "Surveyor III Site", "KREEP Geochemical Anomaly"]
  }
];
