// Schema shown to the model in live mode, and described to the reader. This is
// the real blogs.noaa table on the ClickHouse playground (global daily weather).

export const SCHEMA_TEXT = `Table blogs.noaa (global daily weather, ~1.08B rows):
  station_id String, date Date, tempAvg Int32, tempMax Int32, tempMin Int32,
  precipitation UInt32, snowfall UInt32, snowDepth UInt32, percentDailySun UInt8,
  averageWindSpeed UInt32, maxWindSpeed UInt32, weatherType Enum, elevation Float32, name String
Temperatures are in tenths of degrees Celsius. This is ClickHouse SQL.`;

export const SCHEMA_NOTE =
  "Table: blogs.noaa on the ClickHouse playground — ~1.08B rows of global daily weather. Temps in tenths of °C.";
