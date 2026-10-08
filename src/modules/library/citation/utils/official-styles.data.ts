/**
 * Official Built-in CSL 1.0 XML Stylesheets
 * Provides high-performance instant fallback for IEEE, Nature, Chicago, and MLA
 * without requiring initial network roundtrips to Zotero/GitHub.
 */

export const IEEE_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="numeric" version="1.0" demote-non-dropping-particle="sort-only">
  <info>
    <title>IEEE</title>
    <id>http://www.zotero.org/styles/ieee</id>
    <link href="http://www.zotero.org/styles/ieee" rel="self"/>
    <author><name>Michael Berkowitz</name></author>
    <category citation-format="numeric"/>
    <category field="engineering"/>
    <updated>2020-01-01T00:00:00+00:00</updated>
  </info>
  <citation collapse="citation-number">
    <sort><key variable="citation-number"/></sort>
    <layout prefix="[" suffix="]" delimiter=", ">
      <text variable="citation-number"/>
    </layout>
  </citation>
  <bibliography entry-spacing="0" second-field-align="flush">
    <layout suffix=".">
      <text variable="citation-number" prefix="[" suffix="] "/>
      <names variable="author" suffix=", ">
        <name initialize-with=". " delimiter=", " and="text"/>
      </names>
      <text variable="title" quotes="true" suffix=", "/>
      <text variable="container-title" font-style="italic" suffix=", "/>
      <date variable="issued" prefix="vol. " suffix=", ">
        <date-part name="volume"/>
      </date>
      <date variable="issued">
        <date-part name="year"/>
      </date>
    </layout>
  </bibliography>
</style>`;

export const NATURE_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="numeric" version="1.0" demote-non-dropping-particle="sort-only">
  <info>
    <title>Nature</title>
    <id>http://www.zotero.org/styles/nature</id>
    <link href="http://www.zotero.org/styles/nature" rel="self"/>
    <category citation-format="numeric"/>
    <category field="science"/>
    <updated>2020-01-01T00:00:00+00:00</updated>
  </info>
  <citation collapse="citation-number">
    <sort><key variable="citation-number"/></sort>
    <layout vertical-align="sup" delimiter=",">
      <text variable="citation-number"/>
    </layout>
  </citation>
  <bibliography et-al-min="6" et-al-use-first="1" second-field-align="flush" entry-spacing="0">
    <layout>
      <text variable="citation-number" suffix=". "/>
      <names variable="author" suffix=" ">
        <name sort-separator=", " initialize-with=". " delimiter=", " and="symbol" delimiter-precedes-last="never"/>
      </names>
      <text variable="title" suffix=". " font-weight="bold"/>
      <text variable="container-title" font-style="italic" form="short" suffix=" "/>
      <text variable="volume" font-weight="bold" suffix=", "/>
      <text variable="page" suffix=" "/>
      <date variable="issued" prefix="(" suffix=").">
        <date-part name="year"/>
      </date>
    </layout>
  </bibliography>
</style>`;

export const CHICAGO_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" demote-non-dropping-particle="sort-only">
  <info>
    <title>Chicago Manual of Style 17th edition (author-date)</title>
    <id>http://www.zotero.org/styles/chicago-author-date</id>
    <link href="http://www.zotero.org/styles/chicago-author-date" rel="self"/>
    <category citation-format="author-date"/>
    <category field="generic-base"/>
    <updated>2020-01-01T00:00:00+00:00</updated>
  </info>
  <citation et-al-min="4" et-al-use-first="1" disambiguate-add-year-suffix="true" disambiguate-add-names="true">
    <layout prefix="(" suffix=")" delimiter="; ">
      <names variable="author">
        <name form="short" and="text" delimiter=", "/>
      </names>
      <date variable="issued" prefix=" ">
        <date-part name="year"/>
      </date>
    </layout>
  </citation>
  <bibliography hanging-indent="true" et-al-min="11" et-al-use-first="7" entry-spacing="1">
    <layout suffix=".">
      <names variable="author" suffix=". ">
        <name name-as-sort-order="first" and="text" delimiter=", "/>
      </names>
      <date variable="issued" suffix=". ">
        <date-part name="year"/>
      </date>
      <text variable="title" text-case="title" suffix=". "/>
      <text variable="container-title" font-style="italic" suffix=". "/>
    </layout>
  </bibliography>
</style>`;

export const MLA_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" demote-non-dropping-particle="never">
  <info>
    <title>Modern Language Association 9th edition</title>
    <id>http://www.zotero.org/styles/modern-language-association</id>
    <link href="http://www.zotero.org/styles/modern-language-association" rel="self"/>
    <category citation-format="author"/>
    <category field="generic-base"/>
    <updated>2020-01-01T00:00:00+00:00</updated>
  </info>
  <citation et-al-min="3" et-al-use-first="1" disambiguate-add-names="true">
    <layout prefix="(" suffix=")" delimiter="; ">
      <names variable="author">
        <name form="short" and="text" delimiter=", "/>
      </names>
      <text variable="locator" prefix=" "/>
    </layout>
  </citation>
  <bibliography hanging-indent="true" et-al-min="3" et-al-use-first="1" line-spacing="2" entry-spacing="0">
    <layout suffix=".">
      <names variable="author" suffix=". ">
        <name name-as-sort-order="first" and="text" delimiter=", "/>
      </names>
      <text variable="title" quotes="true" suffix=". "/>
      <text variable="container-title" font-style="italic" suffix=", "/>
      <date variable="issued">
        <date-part name="year"/>
      </date>
    </layout>
  </bibliography>
</style>`;

export const TCVN_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="vi-VN">
  <info>
    <title>Tiêu chuẩn Việt Nam - Bộ Giáo dục và Đào tạo (Author-Date)</title>
    <id>http://flux.academic/styles/tcvn-author-date</id>
    <link href="http://flux.academic/styles/tcvn-author-date" rel="self"/>
    <author><name>Flux Academic Citation</name></author>
    <category citation-format="author-date"/>
    <category field="generic-base"/>
    <updated>2026-10-08T00:00:00+00:00</updated>
  </info>
  <citation et-al-min="3" et-al-use-first="1" disambiguate-add-year-suffix="true" collapse="year">
    <layout prefix="(" suffix=")" delimiter="; ">
      <group delimiter=", ">
        <names variable="author">
          <name form="short" and="text" delimiter=", "/>
          <substitute>
            <text variable="title" form="short"/>
          </substitute>
        </names>
        <date variable="issued">
          <date-part name="year"/>
        </date>
      </group>
    </layout>
  </citation>
  <bibliography hanging-indent="true" et-al-min="4" et-al-use-first="3" entry-spacing="0">
    <layout suffix=".">
      <names variable="author" suffix=" ">
        <name delimiter=", " and="text"/>
      </names>
      <date variable="issued" prefix="(" suffix="), ">
        <date-part name="year"/>
      </date>
      <choose>
        <if type="article-journal article-magazine" match="any">
          <text variable="title" quotes="true" suffix=", "/>
          <text variable="container-title" font-style="italic" suffix=", "/>
          <group delimiter=", ">
            <text variable="volume" prefix="tập "/>
            <text variable="issue" prefix="số "/>
            <text variable="page" prefix="tr. "/>
          </group>
        </if>
        <else-if type="book report" match="any">
          <text variable="title" font-style="italic" suffix=", "/>
          <group delimiter=", ">
            <text variable="publisher"/>
            <text variable="publisher-place"/>
          </group>
        </else-if>
        <else-if type="paper-conference" match="any">
          <text variable="title" quotes="true" suffix=", "/>
          <text variable="container-title" font-style="italic" prefix="Kỷ yếu " suffix=", "/>
          <text variable="page" prefix="tr. "/>
        </else-if>
        <else-if type="thesis" match="any">
          <text variable="title" font-style="italic" suffix=", "/>
          <text variable="genre" suffix=", "/>
          <text variable="publisher"/>
        </else-if>
        <else>
          <text variable="title" quotes="true" suffix=", "/>
          <text variable="container-title" font-style="italic" suffix=", "/>
          <text variable="URL"/>
        </else>
      </choose>
    </layout>
  </bibliography>
</style>`;

export const TCVN_NUMERIC_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="numeric" version="1.0" default-locale="vi-VN">
  <info>
    <title>Tiêu chuẩn Việt Nam - Bộ Giáo dục và Đào tạo (Numeric)</title>
    <id>http://flux.academic/styles/tcvn-numeric</id>
    <link href="http://flux.academic/styles/tcvn-numeric" rel="self"/>
    <author><name>Flux Academic Citation</name></author>
    <category citation-format="numeric"/>
    <category field="generic-base"/>
    <updated>2026-10-08T00:00:00+00:00</updated>
  </info>
  <citation collapse="citation-number">
    <sort><key variable="citation-number"/></sort>
    <layout prefix="[" suffix="]" delimiter=", ">
      <text variable="citation-number"/>
    </layout>
  </citation>
  <bibliography entry-spacing="0" second-field-align="flush">
    <layout suffix=".">
      <text variable="citation-number" prefix="[" suffix="] "/>
      <names variable="author" suffix=" ">
        <name delimiter=", " and="text"/>
      </names>
      <date variable="issued" prefix="(" suffix="), ">
        <date-part name="year"/>
      </date>
      <choose>
        <if type="article-journal article-magazine" match="any">
          <text variable="title" quotes="true" suffix=", "/>
          <text variable="container-title" font-style="italic" suffix=", "/>
          <group delimiter=", ">
            <text variable="volume" prefix="tập "/>
            <text variable="issue" prefix="số "/>
            <text variable="page" prefix="tr. "/>
          </group>
        </if>
        <else-if type="book report" match="any">
          <text variable="title" font-style="italic" suffix=", "/>
          <group delimiter=", ">
            <text variable="publisher"/>
            <text variable="publisher-place"/>
          </group>
        </else-if>
        <else-if type="paper-conference" match="any">
          <text variable="title" quotes="true" suffix=", "/>
          <text variable="container-title" font-style="italic" prefix="Kỷ yếu " suffix=", "/>
          <text variable="page" prefix="tr. "/>
        </else-if>
        <else-if type="thesis" match="any">
          <text variable="title" font-style="italic" suffix=", "/>
          <text variable="genre" suffix=", "/>
          <text variable="publisher"/>
        </else-if>
        <else>
          <text variable="title" quotes="true" suffix=", "/>
          <text variable="container-title" font-style="italic" suffix=", "/>
          <text variable="URL"/>
        </else>
      </choose>
    </layout>
  </bibliography>
</style>`;
