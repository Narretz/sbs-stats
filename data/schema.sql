CREATE TABLE daily_stats (
    date                       DATE,
    hour                       INTEGER,
    data_collected_at          TEXT,
    last_updated               DATETIME,
    personnel_killed           INTEGER,
    personnel_wounded          INTEGER,
    total_targets_hit          INTEGER,
    total_targets_destroyed    INTEGER,
    total_personnel_casualties INTEGER,
    hit_1       INTEGER,  destroyed_1       INTEGER,  -- Tanks (Танки)
    hit_2       INTEGER,  destroyed_2       INTEGER,  -- APCs / IFVs / ACVs (ББМ, БМП, БТР)
    hit_3       INTEGER,  destroyed_3       INTEGER,  -- Cannons, Howitzers (Гармати, гаубиці)
    hit_4       INTEGER,  destroyed_4       INTEGER,  -- Self-propelled Artillery (САУ)
    hit_5       INTEGER,  destroyed_5       INTEGER,  -- MLRS (РСЗВ) — was "РСЗВ, ЗРК, ЗУ" before split into types 5/32/33 (split was 2026-03-20)
    hit_6       INTEGER,  destroyed_6       INTEGER,  -- Mortars (Міномети)
    hit_7       INTEGER,  destroyed_7       INTEGER,  -- Vehicles, special & engineering equipment (ЛАТ, ВАТ, спец. та інж. техніка)
    hit_8       INTEGER,  destroyed_8       INTEGER,  -- Radar & comms, trench (РЛС та ЗС окопні)
    hit_9       INTEGER,  destroyed_9       INTEGER,  -- Radar & comms, vehicle (РЛС та ЗС техніка)
    hit_10      INTEGER,  destroyed_10      INTEGER,  -- EW, trench (РЕБ окопні)
    hit_11      INTEGER,  destroyed_11      INTEGER,  -- EW, equipment (РЕБ техніка)
    hit_12      INTEGER,  destroyed_12      INTEGER,  -- EW, vehicle (РЕБ авто)
    hit_13      INTEGER,  destroyed_13      INTEGER,  -- Antennas (Антени)
    hit_14      INTEGER,  destroyed_14      INTEGER,  -- Network equipment (Мережеве обладнання)
    hit_15      INTEGER,  destroyed_15      INTEGER,  -- Firing positions (ОС РОВ)
    hit_16      INTEGER,  destroyed_16      INTEGER,  -- Strategic infrastructure (Стратегічна інфраструктура)
    hit_17      INTEGER,  destroyed_17      INTEGER,  -- Tactical infrastructure (Тактична інфраструктура)
    hit_18      INTEGER,  destroyed_18      INTEGER,  -- Motorcycles (Мотоцикли)
    hit_19      INTEGER,  destroyed_19      INTEGER,  -- Military buggies (Військові баггі)
    hit_20      INTEGER,  destroyed_20      INTEGER,  -- Warehouses (Склади)
    hit_21      INTEGER,  destroyed_21      INTEGER,  -- Shelters (Укриття)
    hit_22      INTEGER,  destroyed_22      INTEGER,  -- Dugouts (Бліндажі)
    hit_23      INTEGER,  destroyed_23      INTEGER,  -- Drone launch points (Точки вильоту дронів) — split: anti-drone hits moved to 35 (split was 2026-03-20)
    hit_24      INTEGER,  destroyed_24      INTEGER,  -- Enemy copters (Ворожі коптери)
    hit_25      INTEGER,  destroyed_25      INTEGER,  -- Enemy fixed-wing UAVs (Ворожі крила)
    hit_26      INTEGER,  destroyed_26      INTEGER,  -- Enemy guided missiles (Ворожі НРК)
    hit_27      INTEGER,  destroyed_27      INTEGER,  -- Cameras (Камери)
    hit_28      INTEGER,  destroyed_28      INTEGER,  -- Other (Інше)
    hit_29      INTEGER,  destroyed_29      INTEGER,  -- Helicopter (Гелікоптер)
    hit_30      INTEGER,  destroyed_30      INTEGER,  -- Shaheds (Шахеди)
    hit_31      INTEGER,  destroyed_31      INTEGER,  -- Gerbers (Гербери)
    hit_32      INTEGER,  destroyed_32      INTEGER,  -- SAMs / SAM systems (ЗРК, ЗГРК) — split from old type 5
    hit_33      INTEGER,  destroyed_33      INTEGER,  -- AA guns (ЗУ) — split from old type 5
    hit_34      INTEGER,  destroyed_34      INTEGER,  -- Air defense (ППО)
    hit_35      INTEGER,  destroyed_35      INTEGER,  -- Anti-drone: UAV systems (ЗПМ: БпАК) — split from old type 23
    hit_36      INTEGER,  destroyed_36      INTEGER,  -- MLRS: Portable (РСЗВ: Портативний)
    hit_37      INTEGER,  destroyed_37      INTEGER,  -- UAV control stations (ПУ БпЛА)
    hit_38      INTEGER,  destroyed_38      INTEGER,  -- Ammo depot (ОТ Склад БК)
    hit_39      INTEGER,  destroyed_39      INTEGER,  -- Fuel depot (ОТ Склад ПММ)
    hit_40      INTEGER,  destroyed_40      INTEGER,  -- Equipment depot (ОТ Склад майна)
    PRIMARY KEY (date, hour)
);

CREATE TABLE monthly_stats (
    date                       DATE,
    data_collected_at          TEXT,
    last_updated               DATETIME,
    personnel_killed           INTEGER,
    personnel_wounded          INTEGER,
    total_targets_hit          INTEGER,
    total_targets_destroyed    INTEGER,
    total_personnel_casualties INTEGER,
    hit_1       INTEGER,  destroyed_1       INTEGER,  -- Танки (Tanks)
    hit_2       INTEGER,  destroyed_2       INTEGER,  -- ББМ, БМП, БТР (APCs / IFVs / ACVs)
    hit_3       INTEGER,  destroyed_3       INTEGER,  -- Гармати, гаубиці (Cannons, Howitzers)
    hit_4       INTEGER,  destroyed_4       INTEGER,  -- САУ (Self-propelled Artillery)
    hit_5       INTEGER,  destroyed_5       INTEGER,  -- РСЗВ (MLRS) — was "РСЗВ, ЗРК, ЗУ" before split into 5/32/33
    hit_6       INTEGER,  destroyed_6       INTEGER,  -- Міномети (Mortars)
    hit_7       INTEGER,  destroyed_7       INTEGER,  -- ЛАТ, ВАТ, спец. та інж. техніка (Vehicles, special & engineering equipment)
    hit_8       INTEGER,  destroyed_8       INTEGER,  -- РЛС та ЗС окопні (Radar & comms, trench)
    hit_9       INTEGER,  destroyed_9       INTEGER,  -- РЛС та ЗС техніка (Radar & comms, vehicle)
    hit_10      INTEGER,  destroyed_10      INTEGER,  -- РЕБ окопні (EW, trench)
    hit_11      INTEGER,  destroyed_11      INTEGER,  -- РЕБ техніка (EW, equipment)
    hit_12      INTEGER,  destroyed_12      INTEGER,  -- РЕБ авто (EW, vehicle)
    hit_13      INTEGER,  destroyed_13      INTEGER,  -- Антени (Antennas)
    hit_14      INTEGER,  destroyed_14      INTEGER,  -- Мережеве обладнання (Network equipment)
    hit_15      INTEGER,  destroyed_15      INTEGER,  -- ОС РОВ (Firing positions)
    hit_16      INTEGER,  destroyed_16      INTEGER,  -- Стратегічна інфраструктура (Strategic infrastructure)
    hit_17      INTEGER,  destroyed_17      INTEGER,  -- Тактична інфраструктура (Tactical infrastructure)
    hit_18      INTEGER,  destroyed_18      INTEGER,  -- Мотоцикли (Motorcycles)
    hit_19      INTEGER,  destroyed_19      INTEGER,  -- Військові баггі (Military buggies)
    hit_20      INTEGER,  destroyed_20      INTEGER,  -- Склади (Warehouses)
    hit_21      INTEGER,  destroyed_21      INTEGER,  -- Укриття (Shelters)
    hit_22      INTEGER,  destroyed_22      INTEGER,  -- Бліндажі (Dugouts)
    hit_23      INTEGER,  destroyed_23      INTEGER,  -- Точки вильоту дронів (Drone launch points) — split: anti-drone hits moved to 35
    hit_24      INTEGER,  destroyed_24      INTEGER,  -- Ворожі коптери (Enemy copters)
    hit_25      INTEGER,  destroyed_25      INTEGER,  -- Ворожі крила (Enemy fixed-wing UAVs)
    hit_26      INTEGER,  destroyed_26      INTEGER,  -- Ворожі НРК (Enemy guided missiles)
    hit_27      INTEGER,  destroyed_27      INTEGER,  -- Камери (Cameras)
    hit_28      INTEGER,  destroyed_28      INTEGER,  -- Інше (Other)
    hit_29      INTEGER,  destroyed_29      INTEGER,  -- Гелікоптер (Helicopter)
    hit_30      INTEGER,  destroyed_30      INTEGER,  -- Шахеди (Shaheds)
    hit_31      INTEGER,  destroyed_31      INTEGER,  -- Гербери (Gerbers)
    hit_32      INTEGER,  destroyed_32      INTEGER,  -- ЗРК, ЗГРК (SAMs / SAM systems) — split from old type 5
    hit_33      INTEGER,  destroyed_33      INTEGER,  -- ЗУ (AA guns) — split from old type 5
    hit_34      INTEGER,  destroyed_34      INTEGER,  -- ППО (Air defense)
    hit_35      INTEGER,  destroyed_35      INTEGER,  -- ЗПМ: БпАК (Anti-drone: UAV systems) — split from old type 23
    hit_36      INTEGER,  destroyed_36      INTEGER,  -- РСЗВ: Портативний (MLRS: Portable)
    hit_37      INTEGER,  destroyed_37      INTEGER,  -- ПУ БпЛА (UAV control stations)
    hit_38      INTEGER,  destroyed_38      INTEGER,  -- ОТ Склад БК (Ammo depot)
    hit_39      INTEGER,  destroyed_39      INTEGER,  -- ОТ Склад ПММ (Fuel depot)
    hit_40      INTEGER,  destroyed_40      INTEGER,  -- ОТ Склад майна (Equipment depot)
    PRIMARY KEY (date, data_collected_at)
);
