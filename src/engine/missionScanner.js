/**
 * Mission Requirements Evaluation & Landing Site Candidate Ranking Engine
 * Evaluates lunar surface candidate locations against mission constraints:
 *   - Minimum Sunlight Availability (%)
 *   - Minimum Earth Visibility (%)
 *   - Maximum Terrain Slope (°)
 *   - Maximum Continuous Darkness (hours)
 *
 * Produces:
 *   - Suitable landing locations
 *   - Colour-coded suitability classifications
 *   - Multi-criteria ranked landing site candidates
 */

export const DEFAULT_MISSION_REQUIREMENTS = {
  minSunlightPct: 75.0,
  minEarthVisPct: 50.0,
  maxSlopeDeg: 8.0,
  maxContinuousDarknessHrs: 72.0
};

export const MISSION_PRESETS = [
  {
    id: "artemis_crewed",
    name: "Artemis III Crewed",
    desc: "Conservative slope (<7°), high sunlight (>80%), solid Earth comms, <54h darkness",
    requirements: { minSunlightPct: 80.0, minEarthVisPct: 60.0, maxSlopeDeg: 7.0, maxContinuousDarknessHrs: 54.0 }
  },
  {
    id: "viper_volatiles",
    name: "VIPER Volatiles Rover",
    desc: "Tolerates moderate slope (<9°), lower sun (>65%), cold trap access, <80h darkness",
    requirements: { minSunlightPct: 65.0, minEarthVisPct: 40.0, maxSlopeDeg: 9.0, maxContinuousDarknessHrs: 80.0 }
  },
  {
    id: "solar_power_base",
    name: "Solar Power Base",
    desc: "Maximum solar exposure (>90%), permanent comms (>75%), <24h continuous darkness",
    requirements: { minSunlightPct: 90.0, minEarthVisPct: 75.0, maxSlopeDeg: 10.0, maxContinuousDarknessHrs: 24.0 }
  },
  {
    id: "equatorial_mare",
    name: "Equatorial Mare Science",
    desc: "Flat basalt plains (<12° slope), 100% Earth visibility, accepts 354h lunar night",
    requirements: { minSunlightPct: 45.0, minEarthVisPct: 90.0, maxSlopeDeg: 12.0, maxContinuousDarknessHrs: 354.0 }
  }
];

export const CANDIDATE_LOCATIONS = [
  {
    id: "shackleton_ridge",
    name: "Shackleton Connecting Ridge",
    zone: "South Pole Artemis Zone",
    lat: -89.9,
    lon: 0.0,
    elevation: 1250,
    sunlightPct: 86.4,
    earthVisPct: 82.0,
    slopeDeg: 4.8,
    continuousDarknessHrs: 48.0,
    type: "Permanent Sunlight Ridge",
    description: "Primary Artemis III landing candidate. The high ridge receives continuous sunlight over 86% of the year with direct Earth comms line-of-sight."
  },
  {
    id: "malapert_massif",
    name: "Malapert Mountain (Massif)",
    zone: "South Pole Artemis Zone",
    lat: -86.0,
    lon: 2.7,
    elevation: 5040,
    sunlightPct: 93.2,
    earthVisPct: 94.0,
    slopeDeg: 7.2,
    continuousDarknessHrs: 24.0,
    type: "Towering Massif",
    description: "Towering 5,000m peak offering near-continuous sunlight (93%) and unbroken line-of-sight to Earth for deep space communications."
  },
  {
    id: "connecting_ridge_ext",
    name: "Connecting Ridge Extension",
    zone: "South Pole Artemis Zone",
    lat: -89.4,
    lon: 135.0,
    elevation: 1680,
    sunlightPct: 88.0,
    earthVisPct: 78.0,
    slopeDeg: 5.5,
    continuousDarknessHrs: 52.0,
    type: "Solar Ridge",
    description: "Extends north from Shackleton Rim. Elevated terrain keeps solar arrays illuminated while providing smooth rover descent into shadowed gullies."
  },
  {
    id: "mons_mouton",
    name: "Mons Mouton (Leibnitz Plateau)",
    zone: "South Pole Highlands",
    lat: -84.8,
    lon: 31.0,
    elevation: 3200,
    sunlightPct: 81.5,
    earthVisPct: 88.0,
    slopeDeg: 4.2,
    continuousDarknessHrs: 68.0,
    type: "Plateau Massif",
    description: "Colossal flat-topped lunar mountain. Low average slope (4.2°) provides exceptionally safe landing touchdowns with reliable solar power."
  },
  {
    id: "nobile_rim_1",
    name: "Nobile Crater Rim 1",
    zone: "South Pole Volatiles",
    lat: -85.2,
    lon: 53.5,
    elevation: -1800,
    sunlightPct: 78.5,
    earthVisPct: 74.0,
    slopeDeg: 5.1,
    continuousDarknessHrs: 76.0,
    type: "Volatiles Cold-Trap",
    description: "NASA VIPER mission exploration region. Gentle terrain slope with rich neutron spectrometer volatile signatures nearby."
  },
  {
    id: "nobile_rim_2",
    name: "Nobile Crater Rim 2",
    zone: "South Pole Volatiles",
    lat: -85.0,
    lon: 51.0,
    elevation: -1650,
    sunlightPct: 75.0,
    earthVisPct: 71.0,
    slopeDeg: 6.2,
    continuousDarknessHrs: 88.0,
    type: "Volatiles Cold-Trap",
    description: "Secondary VIPER traverse waypoint. Good balance between illumination and easy transit into permanently shadowed micro-traps."
  },
  {
    id: "shoemaker_ridge",
    name: "Shoemaker Crater Ridge",
    zone: "South Pole Artemis Zone",
    lat: -88.1,
    lon: 45.0,
    elevation: 1100,
    sunlightPct: 83.5,
    earthVisPct: 72.0,
    slopeDeg: 5.9,
    continuousDarknessHrs: 60.0,
    type: "Impact Rim Ridge",
    description: "Ridge between Shoemaker and Faustini craters. Excellent solar illumination with moderate terrain slopes."
  },
  {
    id: "faustini_rim_a",
    name: "Faustini Rim Peak A",
    zone: "South Pole Highlands",
    lat: -87.1,
    lon: 77.0,
    elevation: 1450,
    sunlightPct: 80.2,
    earthVisPct: 62.0,
    slopeDeg: 6.0,
    continuousDarknessHrs: 70.0,
    type: "Crater Rim Peak",
    description: "Elevated peak on north Faustini rim. High illumination but reduced Earth elevation angle due to polar longitude position."
  },
  {
    id: "haworth_crater_ridge",
    name: "Haworth Crater Rim",
    zone: "South Pole Volatiles",
    lat: -87.4,
    lon: -5.0,
    elevation: 400,
    sunlightPct: 72.0,
    earthVisPct: 65.0,
    slopeDeg: 7.8,
    continuousDarknessHrs: 96.0,
    type: "Crater Rim",
    description: "Bordering deep cryo-traps. Slope approaches lander limits on crater interior descent."
  },
  {
    id: "amundsen_rim_peak",
    name: "Amundsen Rim Peak",
    zone: "South Pole Highlands",
    lat: -84.5,
    lon: 85.6,
    elevation: 2100,
    sunlightPct: 76.4,
    earthVisPct: 58.0,
    slopeDeg: 8.4,
    continuousDarknessHrs: 84.0,
    type: "Complex Rim",
    description: "High eastern massif with ancient impact melt sheets. Steep local gullies exceed 8° slope threshold."
  },
  {
    id: "cabeus_subrim",
    name: "Cabeus Crater Sub-Rim",
    zone: "South Pole Volatiles",
    lat: -84.9,
    lon: -35.5,
    elevation: -2200,
    sunlightPct: 64.0,
    earthVisPct: 68.0,
    slopeDeg: 9.1,
    continuousDarknessHrs: 120.0,
    type: "Water Ice Target",
    description: "LCROSS impact confirmation zone (5.5% water ice). Rough terrain and long periods of shadow."
  },
  {
    id: "gerlache_rim",
    name: "de Gerlache Crater Rim 1",
    zone: "South Pole Artemis Zone",
    lat: -88.5,
    lon: -88.3,
    elevation: 950,
    sunlightPct: 79.0,
    earthVisPct: 66.0,
    slopeDeg: 6.4,
    continuousDarknessHrs: 74.0,
    type: "Connecting Ridge",
    description: "Positioned on the saddle connecting de Gerlache and Shackleton craters. Consistent illumination."
  },
  {
    id: "apollo11_tranquillity",
    name: "Apollo 11 &bull; Mare Tranquillitatis",
    zone: "Equatorial Mare",
    lat: 0.67,
    lon: 23.47,
    elevation: -1200,
    sunlightPct: 50.0,
    earthVisPct: 100.0,
    slopeDeg: 1.8,
    continuousDarknessHrs: 354.0,
    type: "Basaltic Plain",
    description: "Statio Tranquillitatis. Flat basaltic mare (1.8° slope) and 100% Earth line-of-sight, but subject to 14.75-day lunar night (354 hours)."
  },
  {
    id: "apollo12_procellarum",
    name: "Apollo 12 &bull; Oceanus Procellarum",
    zone: "Western Mare",
    lat: -3.01,
    lon: -23.42,
    elevation: -2400,
    sunlightPct: 50.0,
    earthVisPct: 100.0,
    slopeDeg: 2.1,
    continuousDarknessHrs: 354.0,
    type: "Basaltic Plain",
    description: "Broad smooth volcanic flood basalt. Ultra-low landing slope, continuous Earth comms, standard diurnal night."
  },
  {
    id: "reiner_gamma",
    name: "Reiner Gamma Swirl",
    zone: "Magnetic Anomaly",
    lat: 7.5,
    lon: -59.0,
    elevation: -1800,
    sunlightPct: 50.0,
    earthVisPct: 98.0,
    slopeDeg: 2.0,
    continuousDarknessHrs: 354.0,
    type: "Lunar Swirl",
    description: "High-albedo mini-magnetosphere swirl. Pristine un-weathered regolith, extremely gentle slope."
  },
  {
    id: "sinus_iridum",
    name: "Sinus Iridum (Bay of Rainbows)",
    zone: "Northern Mare",
    lat: 45.1,
    lon: -31.5,
    elevation: -2900,
    sunlightPct: 50.0,
    earthVisPct: 96.0,
    slopeDeg: 3.2,
    continuousDarknessHrs: 354.0,
    type: "Mare Basin",
    description: "Smooth basalt bay backed by Jura Mountains. Excellent landing safety margins."
  },
  {
    id: "aristarchus_plateau",
    name: "Aristarchus Plateau",
    zone: "Volcanic Science",
    lat: 23.7,
    lon: -47.4,
    elevation: 2800,
    sunlightPct: 50.0,
    earthVisPct: 100.0,
    slopeDeg: 12.4,
    continuousDarknessHrs: 354.0,
    type: "Pyroclastic Plateau",
    description: "Geochemically unique plateau cut by Vallis Schröteri rille. Slope exceeds standard landing threshold."
  },
  {
    id: "tycho_peak",
    name: "Tycho Crater Central Peak",
    zone: "Impact Geophysics",
    lat: -43.3,
    lon: -11.2,
    elevation: -4800,
    sunlightPct: 50.0,
    earthVisPct: 100.0,
    slopeDeg: 18.2,
    continuousDarknessHrs: 354.0,
    type: "Central Peak",
    description: "Spectacular central uplift inside young impact crater. Extremely steep slopes (18.2°) make touchdown hazardous."
  },
  {
    id: "aitken_basin",
    name: "South Pole - Aitken Basin (Far Side)",
    zone: "Lunar Far Side",
    lat: -53.0,
    lon: -169.0,
    elevation: -8200,
    sunlightPct: 50.0,
    earthVisPct: 0.0,
    slopeDeg: 6.8,
    continuousDarknessHrs: 354.0,
    type: "Deepest Basin",
    description: "Massive ancient basin on the far side. Zero direct Earth line-of-sight (requires dedicated lunar relay constellation)."
  },
  {
    id: "change4_von_karman",
    name: "Chang'e 4 &bull; Von Kármán Crater",
    zone: "Lunar Far Side",
    lat: -45.5,
    lon: 177.6,
    elevation: -5900,
    sunlightPct: 50.0,
    earthVisPct: 0.0,
    slopeDeg: 3.5,
    continuousDarknessHrs: 354.0,
    type: "Far Side Lander",
    description: "First historic soft landing on the lunar far side. Excellent flat floor (3.5° slope), but 0% direct Earth visibility."
  }
];

export class MissionSiteScanner {
  constructor() {
    this.requirements = { ...DEFAULT_MISSION_REQUIREMENTS };
    this.candidates = [...CANDIDATE_LOCATIONS];
  }

  setRequirements(req) {
    this.requirements = { ...this.requirements, ...req };
  }

  /**
   * Scans and ranks all candidate landing locations against current mission constraints.
   * Multi-Criteria Decision Analysis (MCDA):
   *   - Weights: Sunlight (30%), Earth Vis (25%), Slope (30%), Darkness Period (15%)
   *   - Hard constraint filters disqualify any location failing a required parameter.
   */
  scan(customRequirements = null) {
    const req = customRequirements || this.requirements;

    let qualifiedCount = 0;
    let marginalCount = 0;
    let disqualifiedCount = 0;

    const evaluated = this.candidates.map((site) => {
      const violations = [];
      const warnings = [];

      // 1. Terrain Slope Check
      const slopePassed = site.slopeDeg <= req.maxSlopeDeg;
      if (!slopePassed) {
        violations.push(`Slope ${site.slopeDeg.toFixed(1)}° exceeds limit (${req.maxSlopeDeg.toFixed(1)}°)`);
      } else if (site.slopeDeg > req.maxSlopeDeg * 0.85) {
        warnings.push(`Slope ${site.slopeDeg.toFixed(1)}° close to safety limit`);
      }

      // 2. Sunlight Availability Check
      const sunPassed = site.sunlightPct >= req.minSunlightPct;
      if (!sunPassed) {
        violations.push(`Sunlight ${site.sunlightPct.toFixed(1)}% below required (${req.minSunlightPct.toFixed(1)}%)`);
      } else if (site.sunlightPct < req.minSunlightPct * 1.08) {
        warnings.push(`Sunlight margin is narrow`);
      }

      // 3. Earth Visibility Check (DTE Communications)
      const earthPassed = site.earthVisPct >= req.minEarthVisPct;
      if (!earthPassed) {
        violations.push(`Earth visibility ${site.earthVisPct.toFixed(0)}% below comms threshold (${req.minEarthVisPct.toFixed(0)}%)`);
      } else if (site.earthVisPct < req.minEarthVisPct * 1.1) {
        warnings.push(`Low Earth visibility angle`);
      }

      // 4. Maximum Continuous Darkness Check
      const darknessPassed = site.continuousDarknessHrs <= req.maxContinuousDarknessHrs;
      if (!darknessPassed) {
        violations.push(`Continuous darkness ${site.continuousDarknessHrs.toFixed(0)}h exceeds max limit (${req.maxContinuousDarknessHrs.toFixed(0)}h)`);
      } else if (site.continuousDarknessHrs > req.maxContinuousDarknessHrs * 0.85) {
        warnings.push(`Darkness period near battery threshold`);
      }

      // Multi-Criteria Weighted Suitability Index
      const wSun = 0.30;
      const wEarth = 0.25;
      const wSlope = 0.30;
      const wDark = 0.15;

      const normSun = Math.max(0.0, Math.min(1.0, site.sunlightPct / 100.0));
      const normEarth = Math.max(0.0, Math.min(1.0, site.earthVisPct / 100.0));
      const normSlope = Math.max(0.0, Math.min(1.0, 1.0 - (site.slopeDeg / Math.max(15.0, req.maxSlopeDeg * 1.5))));
      const normDark = Math.max(0.0, Math.min(1.0, 1.0 - (site.continuousDarknessHrs / Math.max(354.0, req.maxContinuousDarknessHrs))));

      let rawScore = (normSun * wSun + normEarth * wEarth + normSlope * wSlope + normDark * wDark) * 100.0;

      // Status classification
      let status = "QUALIFIED";
      let statusBadge = "PRIME";
      let statusColor = "#10b981"; // Emerald Green

      if (violations.length > 0) {
        status = "DISQUALIFIED";
        statusBadge = "EXCLUDED";
        statusColor = "#ef4444"; // Crimson Red
        rawScore = Math.max(5.0, rawScore * 0.4); // Heavy penalty for violation
        disqualifiedCount++;
      } else if (warnings.length > 0 || rawScore < 75.0) {
        status = "MARGINAL";
        statusBadge = "ACCEPTABLE";
        statusColor = "#f59e0b"; // Amber
        marginalCount++;
      } else {
        qualifiedCount++;
      }

      const score = Math.round(rawScore);

      return {
        ...site,
        score,
        status,
        statusBadge,
        statusColor,
        isSuitable: violations.length === 0,
        violations,
        warnings,
        criteriaCheck: {
          slopePassed,
          sunPassed,
          earthPassed,
          darknessPassed
        }
      };
    });

    // Sort descending: highest suitability score first
    evaluated.sort((a, b) => b.score - a.score);

    // Assign ranking (1 to N)
    const rankedCandidates = evaluated.map((item, idx) => ({
      rank: idx + 1,
      ...item
    }));

    return {
      requirements: { ...req },
      rankedCandidates,
      suitableLocations: rankedCandidates.filter(c => c.isSuitable),
      stats: {
        totalScanned: this.candidates.length,
        qualifiedCount,
        marginalCount,
        disqualifiedCount
      },
      timestamp: new Date().toISOString()
    };
  }
}
