/* ============================================================================
   FILE: vehicle_avoid.js — "Surviving Adamsville" shared vehicle avoidance
   ----------------------------------------------------------------------------
   JOSHUA'S NO-DRIVE-THROUGH-VEHICLES RULE (2026-10-10):
   After a MARTA bus drove straight through Joshua's van while he was driving,
   the rule is now: NO vehicle may pass through another vehicle. Ever.

   When a vehicle's path is blocked by another vehicle:
     1. Check whether there is room to maneuver around it while staying on the
        road surface (never grass — upholds Joshua's standing no-grass rule).
     2. If YES: ease around the blocker (traffic cars shift lane offset).
     3. If NO:  STOP and WAIT for the blocking vehicle to move past, then
        proceed. Waiting vehicles queue naturally behind each other.

   WHO USES THIS:
     - traffic_system.js  (stepCar)      — pass-if-room, else wait (+30s
       shoulder-attempt timeout against a parked blocker)
     - marta_bus_system.js (updateBus)   — buses are full-width on a fixed
       path and cannot verify a passing lane, so they ALWAYS wait
       (follow-don't-ram: match a slow blocker's speed, stop for a stopped one)
     - schoolbus_system.js (updateBus)   — school buses always wait (kids!)
     - semi_system.js     (stepSemi)     — 40-ton semis always wait on road
       states; the wait is excluded from the anti-stuck watchdog
     - (MARTA trains are registered as blockers only — they run on dedicated
       tracks with no grade crossings, and a train cannot stop for road
       traffic anyway.)

   The player's driven van already collides physically with every NPC vehicle
   (v1.6/v1.18 push-out in updateCar), and NPC vehicles now ALSO stop for the
   van — respect runs both directions.

   PERFORMANCE: gather() builds a small array of vehicle records each call.
   Callers invoke blockedAhead() once per vehicle per frame; the inner loop is
   a few dozen cheap arithmetic ops — far below the collision work it replaces.
   ========================================================================== */
(function(){
  'use strict';

  /* Vehicle footprint table (half-length, half-width in world units).
     Matches the dimensions already used by resolveNPCVehicleCollisions(). */
  var DIM = {
    traf:   [2.5, 1.1],   // NPC traffic car
    bus:    [6.0, 1.25],  // MARTA bus
    school: [6.0, 1.25],  // school bus
    semi:   [9.5, 1.5],   // semi tractor-trailer
    patrol: [3.0, 1.3],   // work-crew / inspector patrol vehicle
    cop:    [2.5, 1.1],   // APD police cruiser (police_system.js, 2026-10-10)
    train:  [25.0, 1.5],  // MARTA train (blocker only — never yields)
    car:    [2.5, 1.1]    // parked NPC car / fallback
  };

  /* gather(selfRef) — snapshot every vehicle in the world as a flat record:
       {x, z, hx, hz, halfL, halfW, speed, kind, ref}
     hx,hz = heading unit vector (forward = (sin yaw, cos yaw) convention).
     selfRef (the caller's own record object) is excluded so a vehicle never
     blocks itself. Everything is wrapped in try/catch: any subsystem that
     hasn't initialized yet is simply skipped.
     v1.32 FIX (2026-10-10, police staffing task): the subsystem records
     (TR, MB, SE, SB, MT, RC, CE) are `var`s inside their own files' IIFEs —
     bare references here ALWAYS resolved to undefined, so those blocks were
     SILENTLY SKIPPED and most vehicle types never saw each other through
     this system. Every block now resolves through the window.* handle its
     system actually publishes (verified in each file):
       traffic_system.js  -> window.TRAFFIC.cars
       marta_bus_system.js -> window.MARTA_BUS.buses
       semi_system.js     -> window.SEMIS.semis
       schoolbus_system.js -> window.__sbActive (stop-arm buses; stopped,
                              so speed 0 is correct)
       marta_system.js    -> window.MARTA.trains
       police_system.js   -> window.POLICE.patrols
     Road-crew / code-enforcement patrols are INTENTIONALLY not gathered:
     per Joshua's v1.30 crew render rule their meshes are visible=false
     (pure data scouts) — registering invisible trucks would make traffic
     stop for no visible reason. */
  function gather(selfRef){
    var out = [], i, o, d, S;
    function push(x, z, yaw, kind, speed, ref){
      if (ref === selfRef) return;
      if (!isFinite(x) || !isFinite(z)) return;
      d = DIM[kind] || DIM.car;
      out.push({ x:x, z:z,
                 hx:Math.sin(yaw), hz:Math.cos(yaw),
                 halfL:d[0], halfW:d[1],
                 speed:speed || 0, kind:kind, ref:ref || null });
    }
    try{ S=null; try{ S=window.TRAFFIC; }catch(e){}
      if (S && S.cars)
      for (i=0;i<S.cars.length;i++){ o=S.cars[i]; push(o.x,o.z,o.heading,'traf',o.speed,o); } }catch(e){}
    try{ S=null; try{ S=window.MARTA_BUS; }catch(e){}
      if (S && S.buses)
      for (i=0;i<S.buses.length;i++){ o=S.buses[i]; push(o.x,o.z,o.yaw,'bus',o.speed,o); } }catch(e){}
    try{ S=null; try{ S=window.SEMIS; }catch(e){}
      if (S && S.semis)
      for (i=0;i<S.semis.length;i++){ o=S.semis[i]; push(o.x,o.z,o.heading,'semi',o.speed,o); } }catch(e){}
    try{ S=null; try{ S=window.__sbActive; }catch(e){}
      if (S && S.length)
      for (i=0;i<S.length;i++){ o=S[i]; push(o.x,o.z,o.yaw||0,'school',0,o); } }catch(e){}
    try{ S=null; try{ S=window.MARTA; }catch(e){}
      if (S && S.trains)
      for (i=0;i<S.trains.length;i++){ o=S.trains[i]; push(o.x,o.z,o.yaw,'train',o.speed,o); } }catch(e){}
    /* APD police cruisers (police_system.js, 2026-10-10) — registered as
       'cop' so civilian traffic, buses, and semis yield to THEM too.
       Units expose x/z/heading/speed; selfRef exclusion works because the
       unit record itself is passed as ref. */
    try{ S=null; try{ S=window.POLICE; }catch(e){}
      if (S && S.patrols)
      for (i=0;i<S.patrols.length;i++){ o=S.patrols[i]; push(o.x,o.z,o.heading,'cop',o.speed,o); } }catch(e){}
    /* parked NPC cars (driveways etc.) — static obstacles, still block */
    try{ if (typeof cars!=='undefined' && cars)
      for (i=0;i<cars.length;i++){ o=cars[i]; if(o.sunk||o.sinking) continue;
        push(o.x,o.z,o.yaw,'car',o.speed,o); } }catch(e){}
    /* the player's van, but ONLY while being driven — a parked van is already
       covered by the cars[] loop above (car is cars[0]-ish); the driving flag
       distinguishes "traffic participant" from "parked obstacle". */
    try{ if (typeof car!=='undefined' && car && car.driving && !car.sunk && !car.sinking)
      push(car.x, car.z, car.yaw, 'traf', Math.abs(car.speed||0), car); }catch(e){}
    return out;
  }

  /* blockedAhead(x, z, hx, hz, selfRef, maxDist, ownHalfW, tight)
     Returns the nearest vehicle inside a forward cone, or null.
       fwd  in (2, maxDist]   — 2u dead-zone so near-touching bumpers don't
                                self-trigger; actual contact is handled by the
                                existing push-out resolvers.
       |lat| <= ownHalfW + o.halfW + margin
     tight=true shrinks the lateral margin (buses: oncoming traffic in the
     adjacent lane must NOT trigger a stop — only something actually in the
     bus's path does). */
  function blockedAhead(x, z, hx, hz, selfRef, maxDist, ownHalfW, tight){
    var list = gather(selfRef), best = null, i, o, dx, dz, fwd, lat, need;
    var margin = tight ? 0.35 : 0.7;
    for (i=0;i<list.length;i++){
      o = list[i];
      dx = o.x - x; dz = o.z - z;
      fwd = dx*hx + dz*hz;
      if (fwd < 2 || fwd > maxDist) continue;
      lat = dx*hz - dz*hx;                 // signed lateral (+ = right of heading)
      need = ownHalfW + o.halfW + margin;
      if (lat > need || lat < -need) continue;
      if (!best || fwd < best.dist) best = { dist:fwd, lat:lat, o:o };
    }
    return best;
  }

  /* corridorClear(x, z, hx, hz, latOff, dist, selfRef, ownHalfW)
     True when a parallel path offset latOff (right-positive, world units)
     from the current heading is free of vehicles for `dist` ahead. Used by
     traffic cars to verify a passing lane BEFORE committing to it. Samples
     three points along the offset path; each must be clear within
     (3.2 + ownHalfW) so the full car body fits, not just its center. */
  function corridorClear(x, z, hx, hz, latOff, dist, selfRef, ownHalfW){
    var rx = -hz, rz = hx;                // anatomical right of heading
    var list = gather(selfRef), i, o, k, px, pz, dx, dz, rr;
    rr = 3.2 + (ownHalfW || 1.1); rr *= rr;
    var steps = [0.3, 0.6, 1.0];
    for (k=0;k<steps.length;k++){
      var f = dist * steps[k];
      px = x + hx*f + rx*latOff;
      pz = z + hz*f + rz*latOff;
      for (i=0;i<list.length;i++){
        o = list[i];
        dx = o.x - px; dz = o.z - pz;
        if (dx*dx + dz*dz < rr) return false;
      }
    }
    return true;
  }

  window.VehicleAvoid = {
    gather: gather,
    blockedAhead: blockedAhead,
    corridorClear: corridorClear
  };
})();
