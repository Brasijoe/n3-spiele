-- Übernahme der bisherigen Daten aus dem Prototyp (Stand 2026-11-09).
-- Vor dem Umzug bitte noch einmal die aktuellen Partien/Runden aus dem Prototyp prüfen und ergänzen.
INSERT OR IGNORE INTO plays(id, game_id, game, guest, year, date, players, winner, note, duration, first_play, created_at)
VALUES('7q29omvl59uycqwoia8k', 266192, 'Flügelschlag', 0, NULL, '2026-11-07', 4, '', '', NULL, 0, '2026-11-07T19:58:17.611Z');

-- Runde aus dem Prototyp. Der Gastgeber-Schlüssel ist nicht mehr bekannt, deshalb kann sie nur per Admin gelöscht werden.
INSERT OR IGNORE INTO parties(id, game_id, game, guest, year, date, time, seats, host, host_key_hash, note, attendees, created_at)
VALUES('odp2kpsb0l82kslezva1', 371433, 'Terrorscape', 0, 2023, '2026-11-10', '18:00', 4, 'Johannes', 'd965c49aa23e26a314a64f96f1473fc10f001acc7977cd349ae102a472c8fe39', '', '{}', '2026-11-09T11:01:26.601Z');
