import { escapeHtml } from '../core/template.js';

/**
 * Member map without any map service: members who chose to show their city appear as dots on a dotted outline of the world or of
 * Europe (a coarse land mask built from hand-drawn outlines, so no tiles, no fonts, no requests to third parties). A city is
 * looked up in a small table of larger towns, otherwise the country's centre is used; places that are neither known are only listed.
 * Positions are never more exact than the town – nobody can be found by the dot.
 */

type LL = [lon: number, lat: number];

// --- places ---------------------------------------------------------------------------------------------------------

/** "Name|lat|lon" – German names first; the aliases below add English and spelling variants. */
const CITY_TABLE = `Berlin|52.52|13.40;Hamburg|53.55|9.99;München|48.14|11.58;Köln|50.94|6.96;Frankfurt|50.11|8.68;Stuttgart|48.78|9.18;Düsseldorf|51.23|6.78;Leipzig|51.34|12.37;Dortmund|51.51|7.47;Essen|51.46|7.01;Bremen|53.08|8.80;Dresden|51.05|13.74;Hannover|52.37|9.74;Nürnberg|49.45|11.08;Duisburg|51.43|6.77;Bochum|51.48|7.22;Wuppertal|51.26|7.15;Bielefeld|52.02|8.53;Bonn|50.74|7.10;Münster|51.96|7.63;Karlsruhe|49.01|8.40;Mannheim|49.49|8.47;Augsburg|48.37|10.90;Wiesbaden|50.08|8.24;Mainz|50.00|8.27;Kiel|54.32|10.14;Rostock|54.09|12.14;Freiburg|47.99|7.84;Heidelberg|49.40|8.69;Erfurt|50.98|11.03;Magdeburg|52.13|11.63;Potsdam|52.40|13.07;Lübeck|53.87|10.69;Kassel|51.31|9.48;Saarbrücken|49.24|6.99;Regensburg|49.01|12.10;Würzburg|49.79|9.95;Ulm|48.40|9.99;Osnabrück|52.28|8.04;Oldenburg|53.14|8.21;Braunschweig|52.27|10.52;Göttingen|51.54|9.93;Chemnitz|50.83|12.92;Aachen|50.78|6.08;Trier|49.76|6.64;Konstanz|47.66|9.17;Ingolstadt|48.76|11.42;Jena|50.93|11.59;Gießen|50.58|8.68;Darmstadt|49.87|8.65;Bayreuth|49.94|11.58;Paderborn|51.72|8.75;Flensburg|54.78|9.44;Wien|48.21|16.37;Graz|47.07|15.44;Linz|48.31|14.29;Salzburg|47.81|13.04;Innsbruck|47.26|11.39;Klagenfurt|46.62|14.31;Dornbirn|47.41|9.74;Zürich|47.38|8.54;Genf|46.20|6.14;Basel|47.56|7.59;Bern|46.95|7.45;Lausanne|46.52|6.63;Luzern|47.05|8.31;St. Gallen|47.42|9.38;Winterthur|47.50|8.72;Lugano|46.00|8.95;London|51.51|-0.13;Paris|48.86|2.35;Madrid|40.42|-3.70;Barcelona|41.39|2.17;Rom|41.90|12.50;Mailand|45.46|9.19;Amsterdam|52.37|4.90;Brüssel|50.85|4.35;Kopenhagen|55.68|12.57;Stockholm|59.33|18.07;Oslo|59.91|10.75;Helsinki|60.17|24.94;Warschau|52.23|21.01;Prag|50.08|14.44;Budapest|47.50|19.04;Lissabon|38.72|-9.14;Athen|37.98|23.73;Dublin|53.35|-6.26;Zagreb|45.81|15.98;Bukarest|44.43|26.10;Sofia|42.70|23.32;Belgrad|44.79|20.45;Istanbul|41.01|28.98;Kiew|50.45|30.52;Moskau|55.76|37.62;Riga|56.95|24.11;Tallinn|59.44|24.75;Wilna|54.69|25.28;Reykjavik|64.15|-21.94;Luxemburg|49.61|6.13;Valencia|39.47|-0.38;Sevilla|37.39|-5.98;Porto|41.15|-8.61;Palma|39.57|2.65;Neapel|40.85|14.27;Turin|45.07|7.69;Florenz|43.77|11.26;Lyon|45.76|4.84;Marseille|43.30|5.37;Manchester|53.48|-2.24;Edinburgh|55.95|-3.19;Glasgow|55.86|-4.25;Birmingham|52.49|-1.89;Rotterdam|51.92|4.48;Antwerpen|51.22|4.40;Göteborg|57.71|11.97;Malmö|55.60|13.00;Bergen|60.39|5.32;Krakau|50.06|19.94;Danzig|54.35|18.65;Breslau|51.11|17.04;Posen|52.41|16.93;Bratislava|48.15|17.11;Ljubljana|46.06|14.51;Bologna|44.49|11.34;Venedig|45.44|12.32;Toulouse|43.60|1.44;Bordeaux|44.84|-0.58;Nizza|43.71|7.26;Straßburg|48.57|7.75;Bilbao|43.26|-2.93;Málaga|36.72|-4.42;Zypern|35.17|33.36;Thessaloniki|40.64|22.94;Cork|51.90|-8.47;Leeds|53.80|-1.55;Bristol|51.45|-2.59;Aarhus|56.16|10.21;Tampere|61.50|23.76;Uppsala|59.86|17.64;New York|40.71|-74.01;Los Angeles|34.05|-118.24;Chicago|41.88|-87.63;San Francisco|37.77|-122.42;Miami|25.76|-80.19;Toronto|43.65|-79.38;Vancouver|49.28|-123.12;Mexiko-Stadt|19.43|-99.13;São Paulo|-23.55|-46.63;Rio de Janeiro|-22.91|-43.17;Buenos Aires|-34.60|-58.38;Santiago|-33.45|-70.67;Bogotá|4.71|-74.07;Lima|-12.05|-77.04;Kapstadt|-33.92|18.42;Johannesburg|-26.20|28.05;Kairo|30.04|31.24;Lagos|6.52|3.38;Nairobi|-1.29|36.82;Dubai|25.20|55.27;Tel Aviv|32.09|34.78;Riad|24.71|46.68;Mumbai|19.08|72.88;Delhi|28.61|77.21;Bangalore|12.97|77.59;Singapur|1.35|103.82;Bangkok|13.76|100.50;Hongkong|22.32|114.17;Tokio|35.68|139.69;Seoul|37.57|126.98;Peking|39.90|116.41;Shanghai|31.23|121.47;Sydney|-33.87|151.21;Melbourne|-37.81|144.96;Auckland|-36.85|174.76;Manila|14.60|120.98;Jakarta|-6.21|106.85;Kuala Lumpur|3.14|101.69;Hanoi|21.03|105.85;Ho-Chi-Minh-Stadt|10.82|106.63;Taipeh|25.03|121.57;Perth|-31.95|115.86;Brisbane|-27.47|153.03;Houston|29.76|-95.37;Dallas|32.78|-96.80;Seattle|47.61|-122.33;Boston|42.36|-71.06;Atlanta|33.75|-84.39;Denver|39.74|-104.99;Austin|30.27|-97.74;Washington|38.91|-77.04;Montreal|45.50|-73.57;Phoenix|33.45|-112.07;Las Vegas|36.17|-115.14;San Diego|32.72|-117.16;Philadelphia|39.95|-75.17;Orlando|28.54|-81.38;Calgary|51.05|-114.07;Lagos Nigeria|6.52|3.38;Casablanca|33.57|-7.59;Accra|5.60|-0.19;Tunis|36.81|10.18;Karachi|24.86|67.00;Teheran|35.69|51.39;Colombo|6.93|79.86;Kathmandu|27.72|85.32;Dhaka|23.81|90.41;Osaka|34.69|135.50;Cebu|10.32|123.89;Bali|-8.41|115.19;Adelaide|-34.93|138.60;Wellington|-41.29|174.78;Medellín|6.24|-75.58;Quito|-0.18|-78.47;Montevideo|-34.90|-56.16;Havanna|23.11|-82.37;Panama-Stadt|8.98|-79.52;San José|9.93|-84.08`;

/** Spelling variants and English names → the German name in the table. */
const ALIASES: Record<string, string> = {
  munich: 'München', cologne: 'Köln', vienna: 'Wien', zurich: 'Zürich', geneva: 'Genf', genf: 'Genf', prague: 'Prag', warsaw: 'Warschau', rome: 'Rom', milan: 'Mailand', lisbon: 'Lissabon',
  copenhagen: 'Kopenhagen', brussels: 'Brüssel', athens: 'Athen', moscow: 'Moskau', kyiv: 'Kiew', kiev: 'Kiew', 'cape town': 'Kapstadt', tokyo: 'Tokio', beijing: 'Peking', 'hong kong': 'Hongkong',
  singapore: 'Singapur', 'mexico city': 'Mexiko-Stadt', 'sao paulo': 'São Paulo', nuremberg: 'Nürnberg', hanover: 'Hannover', florence: 'Florenz', naples: 'Neapel', turin: 'Turin', gothenburg: 'Göteborg',
  krakow: 'Krakau', cracow: 'Krakau', gdansk: 'Danzig', wroclaw: 'Breslau', poznan: 'Posen', venice: 'Venedig', nice: 'Nizza', strasbourg: 'Straßburg', cairo: 'Kairo', 'tel-aviv': 'Tel Aviv', riyadh: 'Riad',
  'rio': 'Rio de Janeiro', 'ho chi minh city': 'Ho-Chi-Minh-Stadt', 'saigon': 'Ho-Chi-Minh-Stadt', taipei: 'Taipeh', washington: 'Washington', 'washington dc': 'Washington', 'new york city': 'New York', nyc: 'New York',
  frankfurtmain: 'Frankfurt', 'frankfurt am main': 'Frankfurt', 'frankfurt a.m.': 'Frankfurt', 'koln': 'Köln', 'dusseldorf': 'Düsseldorf', 'duesseldorf': 'Düsseldorf', 'muenchen': 'München', 'nurnberg': 'Nürnberg', 'nuernberg': 'Nürnberg',
  'zuerich': 'Zürich', 'wuerzburg': 'Würzburg', 'luebeck': 'Lübeck', 'goettingen': 'Göttingen', 'osnabrueck': 'Osnabrück', 'saarbruecken': 'Saarbrücken', 'muenster': 'Münster', 'giessen': 'Gießen', 'st gallen': 'St. Gallen', 'sankt gallen': 'St. Gallen',
  'lucerne': 'Luzern', 'basle': 'Basel', 'luxembourg': 'Luxemburg', 'bucharest': 'Bukarest', belgrade: 'Belgrad', 'vilnius': 'Wilna', 'zypern': 'Zypern', nicosia: 'Zypern', mumbai: 'Mumbai', bombay: 'Mumbai', 'new delhi': 'Delhi', kolkata: 'Delhi', 'johannesburg': 'Johannesburg', 'jo\'burg': 'Johannesburg',
};

/** Country → [lat, lon] of its middle, by German and English name, plus common codes. */
const COUNTRY_TABLE = `Deutschland|Germany|DE|51.2|10.4;Österreich|Austria|AT|47.6|14.1;Schweiz|Switzerland|CH|46.8|8.2;Frankreich|France|FR|46.6|2.4;Italien|Italy|IT|42.8|12.5;Spanien|Spain|ES|40.2|-3.7;Portugal|Portugal|PT|39.6|-8.0;Niederlande|Netherlands|NL|52.2|5.5;Belgien|Belgium|BE|50.6|4.7;Luxemburg|Luxembourg|LU|49.8|6.1;Dänemark|Denmark|DK|56.0|10.0;Schweden|Sweden|SE|62.0|15.0;Norwegen|Norway|NO|61.0|9.0;Finnland|Finland|FI|64.0|26.0;Polen|Poland|PL|52.0|19.4;Tschechien|Czechia|CZ|49.8|15.5;Slowakei|Slovakia|SK|48.7|19.5;Ungarn|Hungary|HU|47.2|19.5;Rumänien|Romania|RO|45.9|25.0;Bulgarien|Bulgaria|BG|42.7|25.5;Griechenland|Greece|GR|39.1|22.0;Türkei|Turkey|TR|39.0|35.0;Großbritannien|United Kingdom|GB|54.0|-2.5;Irland|Ireland|IE|53.2|-8.0;Island|Iceland|IS|64.9|-18.5;Kroatien|Croatia|HR|45.1|15.2;Slowenien|Slovenia|SI|46.1|14.8;Serbien|Serbia|RS|44.0|21.0;Ukraine|Ukraine|UA|49.0|32.0;Russland|Russia|RU|60.0|60.0;USA|United States|US|39.8|-98.6;Kanada|Canada|CA|56.1|-106.3;Mexiko|Mexico|MX|23.6|-102.5;Brasilien|Brazil|BR|-10.0|-52.0;Argentinien|Argentina|AR|-35.0|-65.0;Chile|Chile|CL|-33.0|-71.0;Kolumbien|Colombia|CO|4.0|-73.0;Peru|Peru|PE|-9.2|-75.0;Südafrika|South Africa|ZA|-29.0|25.0;Ägypten|Egypt|EG|26.8|30.0;Nigeria|Nigeria|NG|9.6|8.1;Kenia|Kenya|KE|0.2|37.9;Marokko|Morocco|MA|31.8|-7.1;Israel|Israel|IL|31.4|35.0;Vereinigte Arabische Emirate|United Arab Emirates|AE|24.0|54.0;Saudi-Arabien|Saudi Arabia|SA|24.0|45.0;Indien|India|IN|21.0|78.0;China|China|CN|35.0|103.0;Japan|Japan|JP|36.0|138.0;Südkorea|South Korea|KR|36.5|127.9;Thailand|Thailand|TH|15.0|101.0;Vietnam|Vietnam|VN|16.0|107.0;Indonesien|Indonesia|ID|-2.0|118.0;Philippinen|Philippines|PH|12.5|122.0;Malaysia|Malaysia|MY|4.2|102.0;Singapur|Singapore|SG|1.35|103.8;Australien|Australia|AU|-25.0|134.0;Neuseeland|New Zealand|NZ|-41.0|174.0;Estland|Estonia|EE|58.7|25.5;Lettland|Latvia|LV|56.9|24.9;Litauen|Lithuania|LT|55.3|23.9;Zypern|Cyprus|CY|35.0|33.2;Malta|Malta|MT|35.9|14.4;Liechtenstein|Liechtenstein|LI|47.2|9.55;Pakistan|Pakistan|PK|30.0|70.0;Bangladesch|Bangladesh|BD|23.7|90.3;Iran|Iran|IR|32.0|53.0;Ghana|Ghana|GH|7.9|-1.0;Tunesien|Tunisia|TN|34.0|9.0;Uruguay|Uruguay|UY|-33.0|-56.0;Ecuador|Ecuador|EC|-1.4|-78.5;Kuba|Cuba|CU|21.5|-79.5;Costa Rica|Costa Rica|CR|9.9|-84.2;Panama|Panama|PA|8.5|-80.0;Bosnien und Herzegowina|Bosnia and Herzegovina|BA|44.2|17.8;Albanien|Albania|AL|41.1|20.0;Nordmazedonien|North Macedonia|MK|41.6|21.7;Montenegro|Montenegro|ME|42.8|19.3;Weißrussland|Belarus|BY|53.5|28.0;Moldau|Moldova|MD|47.2|28.5`;

const fold = (s: string) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/ae/g, 'a')
    .replace(/oe/g, 'o')
    .replace(/ue/g, 'u')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

let cities: Map<string, { name: string; lat: number; lon: number }> | undefined;
let countries: Map<string, { name: string; lat: number; lon: number }> | undefined;

function tables() {
  if (!cities) {
    cities = new Map();
    for (const row of CITY_TABLE.split(';')) {
      const [name, lat, lon] = row.split('|');
      cities.set(fold(name), { name, lat: Number(lat), lon: Number(lon) });
    }
    for (const [alias, to] of Object.entries(ALIASES)) {
      const c = cities.get(fold(to));
      if (c) cities.set(fold(alias), c);
    }
    countries = new Map();
    for (const row of COUNTRY_TABLE.split(';')) {
      const [de, en, code, lat, lon] = row.split('|');
      const v = { name: de, lat: Number(lat), lon: Number(lon) };
      for (const k of [de, en, code]) countries.set(fold(k), v);
    }
    for (const [alias, to] of [['uk', 'GB'], ['england', 'GB'], ['scotland', 'GB'], ['schottland', 'GB'], ['vereinigtes konigreich', 'GB'], ['usa', 'US'], ['vereinigte staaten', 'US'], ['america', 'US'], ['czech republic', 'CZ'], ['uae', 'AE'], ['vae', 'AE'], ['holland', 'NL'], ['osterreich', 'AT'], ['suisse', 'CH'], ['schweiz', 'CH']]) {
      const c = countries.get(fold(to));
      if (c) countries.set(fold(alias), c);
    }
  }
  return { cities: cities!, countries: countries! };
}

export interface Located {
  /** Display name of the place (the town, or the country when only that is known). */
  place: string;
  country: string;
  lat: number;
  lon: number;
  precision: 'city' | 'country';
}

/** Where a profile's city and country are on the map, or null when neither is known. */
export function locate(city: string, country: string): Located | null {
  const t = tables();
  const c = t.countries.get(fold(country));
  const hit = t.cities.get(fold(city));
  if (hit) return { place: hit.name, country: c?.name ?? String(country).trim().slice(0, 60), lat: hit.lat, lon: hit.lon, precision: 'city' };
  if (c) return { place: String(city).trim().slice(0, 80) || c.name, country: c.name, lat: c.lat, lon: c.lon, precision: 'country' };
  return null;
}

// --- the dotted outline --------------------------------------------------------------------------------------------------------------------

/** Coarse outlines of the continents (lon, lat), good for dots 2.5° apart. */
const WORLD: LL[][] = [
  // North America with Central America
  [[-168, 66], [-162, 70], [-156, 71.5], [-141, 70], [-128, 70], [-115, 68], [-100, 69], [-95, 72], [-85, 70], [-80, 63], [-94, 60], [-93, 57], [-85, 55], [-80, 52], [-78, 57], [-77, 62], [-70, 60], [-64, 60], [-62, 57], [-56, 52], [-60, 47], [-67, 45], [-70, 42], [-74, 40], [-76, 35], [-81, 31], [-80, 26], [-82, 27], [-84, 30], [-89, 30], [-92, 29.5], [-97, 28], [-97.5, 22], [-95, 18.5], [-91, 18.5], [-90, 21], [-87, 21.5], [-88, 16], [-84, 15.5], [-83, 11], [-80, 9], [-77.5, 8.5], [-80, 7.2], [-84, 9], [-86, 12], [-88, 13.2], [-92, 14.5], [-96, 15.8], [-105, 20], [-106, 23], [-110, 27], [-113, 31], [-115, 30], [-110, 23], [-112, 25], [-114.5, 30], [-117, 32.5], [-120.5, 34.5], [-124, 40], [-124.5, 46], [-123, 48.5], [-128, 51], [-131, 55], [-135, 58], [-141, 60], [-148, 60.5], [-152, 58], [-158, 56.5], [-165, 54.5], [-160, 58.5], [-165, 61], [-166, 64]],
  // Greenland
  [[-73, 78], [-60, 82], [-30, 83.5], [-20, 82], [-18, 76], [-22, 70], [-30, 68], [-40, 65], [-43, 60], [-50, 62], [-53, 67], [-56, 72], [-66, 76]],
  // Baffin Island, Victoria Island
  [[-80, 63], [-72, 62], [-65, 63], [-62, 66], [-68, 70], [-77, 72], [-88, 72], [-85, 68], [-82, 66]],
  [[-118, 70], [-105, 70], [-101, 69], [-108, 67], [-117, 68]],
  // South America
  [[-77, 8.5], [-72, 12], [-64, 10.5], [-60, 8.5], [-52, 5], [-50, 0], [-44, -2], [-35, -5], [-35, -9], [-39, -14], [-41, -22], [-48, -26], [-49, -29], [-53, -34], [-58, -35], [-57, -38], [-62, -39], [-65, -41], [-65, -45], [-68, -50], [-69, -52], [-68, -55], [-72, -54], [-75, -50], [-73, -42], [-73, -37], [-71, -30], [-70, -18], [-76, -14], [-81, -5], [-80, -1], [-78, 2]],
  // Cuba, Hispaniola
  [[-85, 22], [-80, 23], [-74, 20], [-78, 20], [-82, 22]],
  [[-74, 19.5], [-68.5, 19], [-68.5, 18.3], [-72, 18]],
  // Africa
  [[-17, 21], [-16, 16], [-17, 14.5], [-13, 9], [-8, 4.5], [-3, 5], [5, 6], [9, 4], [10, 0], [9, -3], [12, -6], [13, -12], [12, -17], [14.5, -23], [16, -29], [18.4, -34.3], [20, -35], [25, -34], [31, -29.5], [33, -25], [35, -21], [35, -16], [40.5, -15], [40, -10], [39, -5], [41, -1.5], [43, 1], [48, 5], [51, 10.8], [48, 11.5], [43.2, 11.6], [39.5, 15.5], [37, 21], [35, 25.5], [33, 28.5], [32.5, 31.2], [29, 31], [24.5, 31.8], [20, 32], [19, 30.3], [15, 32.3], [10.5, 34], [11, 37], [9, 37.2], [5, 36.8], [-1, 35.5], [-5.5, 35.8], [-9.5, 32], [-13, 28]],
  // Madagascar
  [[44, -25], [47, -25], [50, -15], [49, -12.5], [47, -15], [43.5, -21]],
  // Europe and Asia in two rough pieces, then the peninsulas
  [[-9.5, 43.5], [-1.5, 43.5], [-1.5, 46], [-4.5, 48.5], [-1.5, 49.7], [2, 51], [7, 53.5], [8.5, 55], [10.5, 57.5], [10.5, 55], [14, 54], [19, 54.4], [21, 57], [24, 59.3], [30, 60], [22, 60.3], [21.5, 63], [25, 65.5], [22, 65.8], [17, 62], [19, 59.5], [16.5, 57], [13, 55.5], [11, 58.5], [7, 58], [5, 60.5], [8, 63.5], [14, 67], [19, 70], [26, 71], [31, 70], [40, 67], [33, 66], [41, 66.5], [44, 68], [52, 68], [60, 69], [68, 69], [73, 72], [80, 73], [87, 75], [100, 77.5], [108, 76.5], [113, 74], [128, 72], [140, 72.5], [150, 71], [160, 70], [170, 70], [180, 68.5], [180, 65], [170, 60], [163, 59], [160, 54], [156, 51], [155, 57], [163, 62], [158, 61.5], [152, 59], [143, 59], [137, 54], [141, 52], [140, 48], [135, 43.5], [130, 42.5], [129, 36], [126, 34.5], [126.5, 37.5], [125, 39.5], [121, 39], [122, 37], [119, 35], [121, 32], [122, 30], [120, 26], [117, 23.5], [111, 21.5], [108, 21.5], [106, 18.5], [109, 13], [107, 10.5], [105, 8.7], [103, 10.5], [100.5, 13.4], [99.5, 10], [100.5, 7], [103.5, 2], [101, 2.7], [98.5, 8], [98.5, 13], [97.5, 17], [94.5, 16], [94, 19], [91.5, 22.5], [88, 21.8], [86.5, 20], [84, 18], [80, 15.5], [80, 10], [77.5, 8], [76.5, 10], [73.5, 17], [72.5, 21], [68.5, 23.5], [66.5, 25.5], [61.5, 25.2], [57, 25.7], [56.5, 27], [52, 27.5], [50, 30], [48.5, 29.8], [48, 28], [50.5, 26], [51.5, 24.5], [54, 24], [56, 26], [56.5, 24.5], [59.5, 22.5], [57.5, 19.5], [53, 16.5], [44, 12.7], [43, 14], [42.7, 16.5], [39, 21.5], [35, 28], [34.5, 29.5], [34, 31.5], [35.5, 34], [36, 36.5], [32, 36.2], [27, 37], [26.5, 40], [29, 41], [28, 42], [28, 45], [33, 45], [37, 47], [40, 44], [41, 41], [36, 36.5]],
  [[-9.4, 43], [-9, 37], [-5.5, 36], [0, 38.5], [3, 42], [7, 43.5], [10, 44], [12, 42], [16, 38], [18, 40], [13.5, 45.5], [19, 42], [23, 38], [26, 40.5], [29, 41], [28, 45], [30, 46], [28, 49], [24, 52], [20, 54.4], [14, 54], [10.5, 54], [8.5, 55], [8, 53.5], [4, 52], [2, 51], [-1.5, 49.7], [-4.5, 48.5], [-1.5, 46], [-1.5, 43.5]],
  // British Isles, Iceland, Ireland
  [[-5.7, 50], [1.4, 51.2], [1.7, 52.7], [0, 53.5], [-1.5, 55], [-2, 57.5], [-3.5, 58.6], [-6, 58], [-5.5, 55.5], [-3, 54.5], [-3.2, 53.4], [-4.5, 52.8], [-5.2, 51.7], [-3.5, 51.2]],
  [[-10, 51.6], [-6, 52], [-6, 54.2], [-8, 55.2], [-10, 54]],
  [[-24, 65.5], [-18, 66.5], [-14, 65], [-18, 63.5], [-22, 63.8]],
  // Japan, Taiwan, Sakhalin, Sri Lanka, Philippines, Indonesia, New Guinea, Australia, New Zealand
  [[130, 31], [132, 34], [136, 34], [140, 35], [141.5, 38.5], [142, 41], [140, 40], [138, 37], [133, 35.5], [130, 34]],
  [[140, 42], [145, 43.5], [142, 45.5], [140, 43]],
  [[120, 22], [122, 25], [121, 25.3], [120, 23.5]],
  [[80, 6], [82, 8], [80, 9.8], [79.8, 8]],
  [[120, 18], [122, 18], [124, 12], [126, 7], [122, 7], [120, 13]],
  [[95, 5.5], [98, 4], [104, 0], [106, -3.5], [104, -5.8], [101, -3], [96, 3]],
  [[109, 1], [111, 1.5], [117, 7], [119, 5], [117.5, 1], [116, -4], [111, -3], [109, -1]],
  [[105, -6.5], [114, -7.5], [114.5, -8.5], [106, -7.5]],
  [[119, -1], [121, 1], [125, 1.5], [121, -3], [123, -5], [120.5, -5.5]],
  [[131, -1], [138, -1.5], [141, -2.5], [147, -6], [150, -10], [143, -9], [138, -8], [134, -4]],
  [[114, -22], [122, -18], [130, -12], [136, -12], [137, -16], [141, -12.5], [143, -14], [146, -19], [153, -26], [153, -32], [150, -37], [146, -39], [140, -38], [135, -34.5], [131, -31.5], [124, -33], [115, -34], [113, -26]],
  [[145, -41], [148, -41], [147.5, -43.5], [145.5, -42.5]],
  [[172.5, -34.5], [178, -37.5], [176, -41], [174.5, -41.5], [173, -38]],
  [[172.5, -40.5], [174, -41.7], [171, -45], [167, -46.5], [168, -44], [171, -42.5]],
];

/** Finer outlines of Europe for the zoomed map (dots 0.6° apart). */
const EUROPE: LL[][] = [
  [[-9.4, 43], [-8, 43.8], [-5.8, 43.6], [-3, 43.4], [-1.8, 43.4], [-1.3, 44.5], [-1.2, 46.1], [-2.2, 47.2], [-4.4, 47.9], [-4.8, 48.5], [-3, 48.8], [-1.6, 48.6], [-1.6, 49.7], [0.2, 49.5], [1.6, 50.2], [2.6, 51.1], [3.6, 51.5], [4, 52], [4.7, 53], [6, 53.4], [7.2, 53.5], [8.5, 53.7], [8.6, 54], [8.3, 55], [8.1, 56], [8.2, 57], [9.6, 57.5], [10.6, 57.7], [10.4, 56.6], [10.9, 56], [10, 55.5], [9.8, 54.8], [10.9, 54.4], [11.9, 54.2], [12.9, 54.5], [14.2, 53.9], [16, 54.3], [18, 54.8], [19.5, 54.4], [21, 55.4], [21, 56.5], [21.1, 57.5], [22.6, 57.7], [23.6, 57], [24.2, 57.4], [24.4, 58.3], [23.6, 59.2], [24.8, 59.5], [26.5, 59.5], [28, 59.5], [30, 59.9], [28, 60.5], [26, 60.4], [23, 59.9], [21.5, 60.5], [21.3, 61.5], [21.5, 63], [22.5, 64], [24.5, 65], [25.4, 65.5], [24, 65.8], [22, 65.7], [21, 64.7], [19, 63.2], [17.5, 62], [17.3, 60.8], [18.9, 60], [18.2, 59.3], [16.8, 58.6], [16.6, 57.2], [16, 56.2], [14.3, 55.5], [13, 55.4], [12.8, 56.2], [11.9, 57.7], [11.2, 58.8], [10.7, 59.9], [10, 59.1], [9.5, 58.9], [8, 58.1], [6.6, 58.1], [5.5, 59], [5, 60.4], [5.3, 61.5], [6, 62.4], [7.5, 63.2], [9.5, 63.8], [11, 64.9], [12.8, 66], [14, 67.3], [15.5, 68.3], [17.5, 69], [19.5, 70], [22.5, 70.5], [25.5, 71], [28, 71], [31, 70.2], [33, 69.4], [36, 66], [37, 60], [37, 54], [37, 47], [35, 45.5], [33, 46], [31, 46.5], [30, 45.3], [29.7, 45.2], [28.7, 44], [28, 42.5], [27.9, 41.7], [28.5, 41.2], [26.5, 40.8], [26.2, 40.1], [24.8, 40.8], [23.7, 40.2], [22.8, 40.5], [22.9, 39.4], [24.1, 38.2], [24, 37.7], [23.2, 36.4], [22.4, 36.5], [21.7, 36.8], [21.2, 37.9], [21, 38.5], [20.5, 39.5], [19.5, 40.2], [19.4, 41.4], [19.2, 42], [18.5, 42.4], [16.5, 43.5], [15.2, 44.2], [14.2, 44.9], [13.6, 44.9], [13.7, 45.6], [12.3, 45.3], [12.5, 44.2], [13.5, 43.6], [14.2, 42.2], [16, 41.9], [18.5, 40.2], [17, 39], [16.5, 38.4], [15.7, 38], [15.8, 40], [15.2, 40], [14.2, 40.8], [12.5, 41.5], [11, 42.4], [10.2, 43.6], [9, 44.3], [7.5, 43.8], [6, 43.1], [4.5, 43.4], [3.2, 43.1], [3.2, 42.3], [2.2, 41.4], [0.8, 40.8], [0, 39.8], [-0.3, 38.7], [-0.8, 37.6], [-2, 36.8], [-4.4, 36.7], [-5.4, 36], [-6.3, 36.5], [-7.4, 37.2], [-8.9, 37], [-8.8, 38.5], [-9.5, 38.7], [-9, 40.5], [-8.8, 41.9]],
  // Great Britain, Ireland, Iceland
  [[-5.7, 50], [-3.5, 50.4], [1.4, 51.2], [1.7, 52.7], [0.3, 53.4], [-0.2, 54.5], [-1.5, 55.2], [-2, 56.4], [-1.8, 57.5], [-3.5, 58.6], [-5, 58.6], [-6, 57.5], [-5.5, 56], [-5, 55], [-3, 54.8], [-3.1, 53.4], [-4.5, 53.3], [-4.2, 52.4], [-5.2, 51.8], [-3.5, 51.4]],
  [[-10, 51.6], [-8, 51.7], [-6, 52.2], [-6.1, 54.2], [-5.8, 55.2], [-7.5, 55.3], [-9.5, 54.3], [-10, 53]],
  [[-24, 65.5], [-22, 66.2], [-18, 66.2], [-14.5, 65.2], [-14, 64.4], [-18, 63.4], [-22, 63.8]],
  // Sicily, Sardinia, Corsica, Crete, Zealand, Gotland, Anatolia, Mallorca, Cyprus
  [[12.5, 38.1], [15.6, 38.2], [15.1, 36.7], [12.5, 37.6]],
  [[8.2, 41], [9.7, 41], [9.7, 39], [8.5, 38.9]],
  [[8.6, 42.2], [9.5, 42.9], [9.5, 41.5], [8.8, 41.4]],
  [[23.5, 35.5], [26.3, 35.3], [26, 35], [23.6, 35]],
  [[11.1, 55.3], [12.6, 55.9], [12.5, 55.1], [11.5, 54.9]],
  [[18, 57.8], [18.9, 57.8], [18.5, 56.9]],
  [[26.5, 40.5], [29, 41.2], [35, 42], [41.5, 41.5], [41.5, 40], [36, 36.5], [32, 36.2], [27.5, 37], [26.5, 38.5]],
  [[2.4, 39.6], [3.4, 39.9], [3.2, 39.3]],
  [[32.3, 35], [34.5, 35.6], [34, 34.9]],
  // North Africa (the top strip) and the Black Sea's southern lands
  [[-6, 35.8], [-2, 35.1], [3, 36.7], [10, 37.2], [11, 36.4], [10.2, 34.2], [3, 32], [-4, 32.5], [-6.5, 34.5]],
];

export type Region = 'world' | 'europe';

const REGIONS: Record<Region, { lon0: number; lon1: number; lat0: number; lat1: number; step: number; shapes: LL[][] }> = {
  world: { lon0: -170, lon1: 180, lat0: -57, lat1: 83, step: 2.5, shapes: WORLD },
  europe: { lon0: -12, lon1: 33, lat0: 34, lat1: 71.5, step: 0.62, shapes: EUROPE },
};

function inside(pt: LL, poly: LL[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const grids = new Map<Region, [number, number][]>();

/** Land dots of a region as [lon, lat] (computed once). */
function landDots(region: Region): [number, number][] {
  let dots = grids.get(region);
  if (dots) return dots;
  const r = REGIONS[region];
  dots = [];
  for (let lat = r.lat1; lat >= r.lat0; lat -= r.step) for (let lon = r.lon0; lon <= r.lon1; lon += r.step) if (r.shapes.some((s) => inside([lon, lat], s))) dots.push([lon, lat]);
  grids.set(region, dots);
  return dots;
}

export interface MapPoint {
  lat: number;
  lon: number;
  place: string;
  n: number;
}

/** Does the region show this position? */
export const inRegion = (region: Region, lat: number, lon: number) => {
  const r = REGIONS[region];
  return lon >= r.lon0 && lon <= r.lon1 && lat >= r.lat0 && lat <= r.lat1;
};

const W = 720;

/** The map as inline SVG: a dotted land mask (one path of round dots) and a bigger dot for every place with members. */
export function mapSvg(region: Region, points: MapPoint[], label = 'Karte der Mitglieder'): string {
  const r = REGIONS[region];
  const sx = W / (r.lon1 - r.lon0);
  const H = Math.round((r.lat1 - r.lat0) * sx * (region === 'world' ? 1 : 1.55));
  const sy = H / (r.lat1 - r.lat0);
  const x = (lon: number) => ((lon - r.lon0) * sx).toFixed(1);
  const y = (lat: number) => ((r.lat1 - lat) * sy).toFixed(1);
  const dot = region === 'world' ? 3.0 : 3.4;
  const land = landDots(region)
    .map(([lon, lat]) => `M${x(lon)} ${y(lat)}h0`)
    .join('');
  const marks = points
    .filter((p) => inRegion(region, p.lat, p.lon))
    .map((p) => {
      const rad = (region === 'world' ? 4 : 6) + Math.min(Math.sqrt(p.n) * 1.6, 12);
      return `<circle cx="${x(p.lon)}" cy="${y(p.lat)}" r="${rad.toFixed(1)}" class="mp"><title>${escapeHtml(p.place)}: ${p.n} ${p.n === 1 ? 'Mitglied' : 'Mitglieder'}</title></circle>`;
    })
    .join('');
  return `<svg class="cm-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(label)}" preserveAspectRatio="xMidYMid meet"><path d="${land}" fill="none" stroke="currentColor" stroke-width="${dot}" stroke-linecap="round" opacity=".22"/>${marks}</svg>`;
}

/** Members → points (one per place) and the rest that can only be listed. */
export function pointsOf(members: { city: string; country: string }[]): { points: MapPoint[]; countries: { country: string; n: number; cities: string[] }[]; unplaced: number } {
  const byPlace = new Map<string, MapPoint & { country: string }>();
  const byCountry = new Map<string, { country: string; n: number; cities: Set<string> }>();
  let unplaced = 0;
  for (const m of members) {
    const l = locate(m.city, m.country);
    if (!l) {
      unplaced++;
      continue;
    }
    const key = `${l.lat.toFixed(2)},${l.lon.toFixed(2)}`;
    const cur = byPlace.get(key);
    if (cur) cur.n++;
    else byPlace.set(key, { lat: l.lat, lon: l.lon, place: l.place, n: 1, country: l.country });
    const c = byCountry.get(l.country) ?? { country: l.country, n: 0, cities: new Set<string>() };
    c.n++;
    if (l.precision === 'city') c.cities.add(l.place);
    byCountry.set(l.country, c);
  }
  return {
    points: [...byPlace.values()].map(({ country: _c, ...p }) => p),
    countries: [...byCountry.values()].sort((a, b) => b.n - a.n || a.country.localeCompare(b.country)).map((c) => ({ country: c.country, n: c.n, cities: [...c.cities].sort() })),
    unplaced,
  };
}
