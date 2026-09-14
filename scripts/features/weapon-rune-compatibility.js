(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix, settings } = tools.module;
  const pending = new Map();
  const reported = new Set();
  let installed = false;

  tools.features ??= {};
  tools.features.weaponRuneCompatibility = { onInit };

  function onInit() {
    if (installed) return;
    const prototype = CONFIG.PF2E?.Actor?.documentClasses?.character?.prototype;
    if (typeof prototype?.prepareStrike !== "function"
      || typeof game.pf2e?.system?.generateItemName !== "function") return;

    const prepareStrike = prototype.prepareStrike;
    prototype.prepareStrike = function (weapon, ...args) {
      try {
        return prepareStrike.call(this, weapon, ...args);
      } catch (error) {
        // PF2e 8.5 looks up property runes before applying strike adjustments.
        // Recover only this known lookup failure, not unrelated preparation errors.
        if (game.settings.get(moduleId, settings.weaponRuneCompatibilityEnabled) === false
          || error?.name !== "TypeError" || !/strikeAdjustments/.test(error.message)
          || !/getPropertyRuneStrikeAdjustments/.test(error.stack ?? "")) throw error;

        const property = weapon.system.runes.property;
        if (!Array.isArray(property)) throw error;
        const recognized = recognizedRunes(property);
        if (!recognized) throw error;
        const unsupported = property.filter((slug) => !recognized.includes(slug));
        if (unsupported.length === 0) throw error;

        // Replace only derived data. The saved rune list stays available for
        // export, repair, or reactivation by its provider after an actor reset.
        weapon.system.runes.property = recognized;
        const strike = prepareStrike.call(this, weapon, ...args);
        reportUnsupportedRunes(this, weapon, unsupported);
        return strike;
      }
    };
    Hooks.once("ready", flushWarnings);
    installed = true;
  }

  function recognizedRunes(runes) {
    // PF2e 8.5 keeps RUNE_DATA private. Its public name generator consults the
    // same dictionary and safely omits unknown properties. Use a name-only
    // object so this probe neither prepares nor mutates any actual document.
    // Do not cache: a module may register a property rune after initialization.
    const generateName = game.pf2e.system.generateItemName;
    const baseType = "dagger";
    const baseKey = CONFIG.PF2E.baseWeaponTypes?.[baseType];
    if (!baseKey) return null;
    const baseName = game.i18n.localize(baseKey);
    const probe = (property) => generateName({
      type: "weapon",
      isOfType: (...types) => types.includes("weapon"),
      baseType,
      isSpecific: false,
      name: baseName,
      _source: { name: baseName },
      system: { runes: { potency: 0, striking: 0, property }, material: { type: null }, grade: null },
    });
    // Fail closed if a replacement name generator does not distinguish a known
    // standard rune from an empty list: it is then not a reliable lookup API.
    const emptyName = probe([]);
    if (probe(["flaming"]) === emptyName) return null;
    return runes.filter((slug) => typeof slug === "string" && probe([slug]) !== emptyName);
  }

  function reportUnsupportedRunes(actor, weapon, runes) {
    const key = `${actor.uuid}:${weapon.id}:${runes.join(",")}`;
    if (reported.has(key)) return;
    pending.set(key, { actor, weaponName: weapon.name, runes });
    if (game.ready) flushWarnings();
  }

  function flushWarnings() {
    for (const [key, { actor, weaponName, runes }] of pending) {
      pending.delete(key);
      if (reported.has(key) || !(game.user?.isGM || actor.isOwner)) continue;
      reported.add(key);
      const message = `${actor.name}: «${weaponName}» — неизвестные руны ${runes.join(", ")}. `
        + "Они сохранены в предмете, но не применяются к атакам. Проверьте модуль-источник или замените руны в свойствах оружия.";
      console.warn(`${logPrefix} | ${message}`);
      ui.notifications.warn(foundry.utils.escapeHTML(message), { permanent: true });
    }
  }
})();
