// The canned storyline runs over a real benchmark table: blogs.noaa on the
// public ClickHouse playground (1.08B rows of global daily weather). Each step
// adds one line of English and one SQL state; consecutive states differ by a
// local edit on purpose. The result rows below are REAL — captured from the
// playground, then snapshotted so the demo is deterministic and needs no network.
// Temperatures are tenths of degrees Celsius in the source, divided to °C here.

export const SCENES = [
  {
    refine: "average high temperature by year",
    sql: `SELECT toYear(date) AS year,
       round(avg(tempMax) / 10, 1) AS avg_high_c
FROM blogs.noaa
GROUP BY year
ORDER BY year DESC`,
    cols: ["year", "avg_high_c"],
    rows: [
      ["2022", "6.4"],
      ["2021", "5.9"],
      ["2020", "6.1"],
      ["2019", "6.1"],
      ["2018", "6.4"],
    ],
  },
  {
    refine: "summer months only",
    sql: `SELECT toYear(date) AS year,
       round(avg(tempMax) / 10, 1) AS avg_high_c
FROM blogs.noaa
WHERE toMonth(date) IN (6, 7, 8)
GROUP BY year
ORDER BY year DESC`,
    cols: ["year", "avg_high_c"],
    rows: [
      ["2022", "9.8"],
      ["2021", "9.0"],
      ["2020", "9.4"],
      ["2019", "9.7"],
      ["2018", "10.1"],
    ],
  },
  {
    refine: "and the record high",
    sql: `SELECT toYear(date) AS year,
       round(avg(tempMax) / 10, 1) AS avg_high_c,
       round(max(tempMax) / 10, 1) AS record_high_c
FROM blogs.noaa
WHERE toMonth(date) IN (6, 7, 8)
GROUP BY year
ORDER BY year DESC`,
    cols: ["year", "avg_high_c", "record_high_c"],
    rows: [
      ["2022", "9.8", "53.0"],
      ["2021", "9.0", "54.4"],
      ["2020", "9.4", "54.4"],
      ["2019", "9.7", "51.7"],
      ["2018", "10.1", "52.8"],
    ],
  },
  {
    refine: "only well-sampled years",
    sql: `SELECT toYear(date) AS year,
       round(avg(tempMax) / 10, 1) AS avg_high_c,
       round(max(tempMax) / 10, 1) AS record_high_c
FROM blogs.noaa
WHERE toMonth(date) IN (6, 7, 8)
GROUP BY year
HAVING count(*) > 100000
ORDER BY year DESC`,
    cols: ["year", "avg_high_c", "record_high_c"],
    rows: [
      ["2022", "9.8", "53.0"],
      ["2021", "9.0", "54.4"],
      ["2020", "9.4", "54.4"],
      ["2019", "9.7", "51.7"],
      ["2018", "10.1", "52.8"],
    ],
  },
  {
    refine: "warmest first",
    sql: `SELECT toYear(date) AS year,
       round(avg(tempMax) / 10, 1) AS avg_high_c,
       round(max(tempMax) / 10, 1) AS record_high_c
FROM blogs.noaa
WHERE toMonth(date) IN (6, 7, 8)
GROUP BY year
HAVING count(*) > 100000
ORDER BY avg_high_c DESC`,
    cols: ["year", "avg_high_c", "record_high_c"],
    rows: [
      ["2003", "16.1", "53.3"],
      ["2001", "16.0", "52.8"],
      ["2002", "16.0", "53.3"],
      ["2006", "15.6", "54.7"],
      ["2005", "15.6", "53.9"],
    ],
  },
  {
    refine: "top 10",
    sql: `SELECT toYear(date) AS year,
       round(avg(tempMax) / 10, 1) AS avg_high_c,
       round(max(tempMax) / 10, 1) AS record_high_c
FROM blogs.noaa
WHERE toMonth(date) IN (6, 7, 8)
GROUP BY year
HAVING count(*) > 100000
ORDER BY avg_high_c DESC
LIMIT 10`,
    cols: ["year", "avg_high_c", "record_high_c"],
    rows: [
      ["2003", "16.1", "53.3"],
      ["2001", "16.0", "52.8"],
      ["2002", "16.0", "53.3"],
      ["2006", "15.6", "54.7"],
      ["2005", "15.6", "53.9"],
    ],
  },
];
