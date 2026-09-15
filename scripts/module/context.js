(function () {
  const moduleId = "pf2e-eliott-tools";

  const tools = (globalThis.pf2eEliottTools ??= {});
  tools.module = {
    id: moduleId,
    flagPath: `flags.${moduleId}.correction`,
    logPrefix: "PF2E Eliott Tools",
    settings: {
      clearTargetsOnTurnEndEnabled: "clearTargetsOnTurnEndEnabled",
      combatTrackerHpRingEnabled: "combatTrackerHpRingEnabled",
      worldClockEnabled: "worldClockEnabled",
      preciousMaterialArmorEnabled: "preciousMaterialArmorEnabled",
      weaponFamiliarityEnabled: "weaponFamiliarityEnabled",
      energyResistantRunesEnabled: "energyResistantRunesEnabled",
      mythicMagicEnabled: "mythicMagicEnabled",
      frightenedRecoveryEnabled: "frightenedRecoveryEnabled",
      oathOfTheDefenderEnabled: "oathOfTheDefenderEnabled",
      criticalDeckTranslationEnabled: "criticalDeckTranslationEnabled",
      shieldsOfTheSpiritEnabled: "shieldsOfTheSpiritEnabled",
    },
  };
})();
