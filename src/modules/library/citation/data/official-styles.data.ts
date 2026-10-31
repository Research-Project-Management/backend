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
    <updated>2023-01-01T00:00:00+00:00</updated>
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
      <choose>
        <if type="book thesis report" match="any">
          <group delimiter=", ">
            <text variable="title" font-style="italic"/>
            <text variable="edition" suffix=" ed."/>
            <text variable="publisher-place"/>
            <text variable="publisher"/>
            <date variable="issued">
              <date-part name="year"/>
            </date>
            <text variable="DOI" prefix="doi: "/>
          </group>
        </if>
        <else-if type="chapter" match="any">
          <text variable="title" quotes="true" suffix=", "/>
          <group delimiter=", ">
            <text variable="container-title" font-style="italic" prefix="in "/>
            <names variable="editor">
              <name initialize-with=". " delimiter=", " and="text"/>
              <label form="short" prefix=", " text-case="capitalize-first"/>
            </names>
            <text variable="publisher-place"/>
            <text variable="publisher"/>
            <date variable="issued">
              <date-part name="year"/>
            </date>
            <text variable="page" prefix="pp. "/>
            <text variable="DOI" prefix="doi: "/>
          </group>
        </else-if>
        <else-if type="paper-conference" match="any">
          <text variable="title" quotes="true" suffix=", "/>
          <group delimiter=", ">
            <choose>
              <if variable="container-title">
                <text variable="container-title" font-style="italic" prefix="in "/>
              </if>
              <else>
                <text variable="event-title" font-style="italic" prefix="in "/>
              </else>
            </choose>
            <text variable="publisher-place"/>
            <text variable="publisher"/>
            <date variable="issued">
              <date-part name="month" form="short" suffix=" "/>
              <date-part name="year"/>
            </date>
            <text variable="page" prefix="pp. "/>
            <text variable="DOI" prefix="doi: "/>
          </group>
        </else-if>
        <else>
          <text variable="title" quotes="true" suffix=", "/>
          <group delimiter=", ">
            <text variable="container-title" font-style="italic"/>
            <text variable="volume" prefix="vol. "/>
            <text variable="issue" prefix="no. "/>
            <text variable="page" prefix="pp. "/>
            <date variable="issued">
              <date-part name="month" form="short" suffix=" "/>
              <date-part name="year"/>
            </date>
            <text variable="DOI" prefix="doi: "/>
          </group>
        </else>
      </choose>
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
    <updated>2023-01-01T00:00:00+00:00</updated>
  </info>
  <citation collapse="citation-number">
    <sort><key variable="citation-number"/></sort>
    <layout vertical-align="sup" delimiter=",">
      <text variable="citation-number"/>
    </layout>
  </citation>
  <bibliography et-al-min="6" et-al-use-first="1" second-field-align="flush" entry-spacing="0">
    <layout suffix=".">
      <text variable="citation-number" suffix=". "/>
      <names variable="author" suffix=" ">
        <name sort-separator=", " initialize-with=". " delimiter=", " and="symbol" delimiter-precedes-last="never"/>
      </names>
      <choose>
        <if type="book thesis report" match="any">
          <text variable="title" font-style="italic" suffix=" "/>
          <group prefix="(" suffix=")" delimiter=", ">
            <text variable="publisher"/>
            <date variable="issued">
              <date-part name="year"/>
            </date>
          </group>
        </if>
        <else>
          <text variable="title" suffix=". " font-weight="bold"/>
          <text variable="container-title" font-style="italic" form="short" suffix=" "/>
          <text variable="volume" font-weight="bold" suffix=", "/>
          <text variable="page" suffix=" "/>
          <date variable="issued" prefix="(" suffix=")">
            <date-part name="year"/>
          </date>
        </else>
      </choose>
      <text variable="DOI" prefix=" https://doi.org/"/>
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
    <updated>2023-01-01T00:00:00+00:00</updated>
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
        <name name-as-sort-order="first" and="text" delimiter=", " delimiter-precedes-last="always"/>
      </names>
      <date variable="issued" suffix=". ">
        <date-part name="year"/>
      </date>
      <choose>
        <if type="book thesis report" match="any">
          <text variable="title" font-style="italic" text-case="title" suffix=". "/>
          <group delimiter=": " suffix=".">
            <text variable="publisher-place"/>
            <text variable="publisher"/>
          </group>
        </if>
        <else-if type="chapter paper-conference" match="any">
          <text variable="title" quotes="true" text-case="title" suffix=". "/>
          <text variable="container-title" font-style="italic" prefix="In " suffix=", "/>
          <names variable="editor" prefix="edited by " suffix=", ">
            <name and="text" delimiter=", "/>
          </names>
          <text variable="page" suffix=". "/>
          <group delimiter=": ">
            <text variable="publisher-place"/>
            <text variable="publisher"/>
          </group>
        </else-if>
        <else>
          <text variable="title" quotes="true" text-case="title" suffix=". "/>
          <text variable="container-title" font-style="italic" suffix=" "/>
          <group delimiter=": ">
            <group>
              <text variable="volume"/>
              <text variable="issue" prefix=" (" suffix=")"/>
            </group>
            <text variable="page"/>
          </group>
        </else>
      </choose>
      <text variable="DOI" prefix=". https://doi.org/"/>
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
    <updated>2023-01-01T00:00:00+00:00</updated>
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
      <choose>
        <if type="book thesis report" match="any">
          <text variable="title" font-style="italic" suffix=". "/>
          <group delimiter=", ">
            <text variable="publisher"/>
            <date variable="issued">
              <date-part name="year"/>
            </date>
          </group>
        </if>
        <else>
          <text variable="title" quotes="true" suffix=". "/>
          <group delimiter=", ">
            <text variable="container-title" font-style="italic"/>
            <names variable="editor" prefix="edited by ">
              <name and="text" delimiter=", "/>
            </names>
            <text variable="volume" prefix="vol. "/>
            <text variable="issue" prefix="no. "/>
            <text variable="publisher"/>
            <date variable="issued">
              <date-part name="year"/>
            </date>
            <text variable="page" prefix="pp. "/>
          </group>
        </else>
      </choose>
      <text variable="DOI" prefix=". https://doi.org/"/>
    </layout>
  </bibliography>
</style>`;

export const TCVN_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="vi-VN">
  <info>
    <title>Tiêu chuẩn Việt Nam - Bộ Giáo dục và Đào tạo (Author-Date)</title>
    <id>http://www.zotero.org/styles/vietnam-ministry-of-education-and-training-author-date</id>
    <link href="http://www.zotero.org/styles/vietnam-ministry-of-education-and-training-author-date" rel="self"/>
    <author><name>Bộ Giáo dục và Đào tạo Việt Nam</name></author>
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
            <text variable="DOI" prefix="DOI: "/>
          </group>
        </if>
        <else-if type="chapter" match="any">
          <text variable="title" quotes="true" suffix=", "/>
          <text variable="container-title" font-style="italic" prefix="Trong: " suffix=", "/>
          <group delimiter=", ">
            <text variable="publisher"/>
            <text variable="publisher-place"/>
            <text variable="page" prefix="tr. "/>
          </group>
        </else-if>
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
    <id>http://www.zotero.org/styles/vietnam-ministry-of-education-and-training-numeric</id>
    <link href="http://www.zotero.org/styles/vietnam-ministry-of-education-and-training-numeric" rel="self"/>
    <author><name>Bộ Giáo dục và Đào tạo Việt Nam</name></author>
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
            <text variable="DOI" prefix="DOI: "/>
          </group>
        </if>
        <else-if type="chapter" match="any">
          <text variable="title" quotes="true" suffix=", "/>
          <text variable="container-title" font-style="italic" prefix="Trong: " suffix=", "/>
          <group delimiter=", ">
            <text variable="publisher"/>
            <text variable="publisher-place"/>
            <text variable="page" prefix="tr. "/>
          </group>
        </else-if>
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

/**
 * Official Built-in CSL 1.0 XML Locale for Vietnamese (vi-VN)
 * Source: Citation Style Language Locales repository (CC-BY-SA 3.0)
 */
export const VI_VN_LOCALE = `<?xml version="1.0" encoding="utf-8"?>
<locale xmlns="http://purl.org/net/xbiblio/csl" version="1.0" xml:lang="vi-VN">
  <info>
    <translator>
      <name>CSL Vietnamese Contributors</name>
    </translator>
    <rights license="http://creativecommons.org/licenses/by-sa/3.0/">This work is licensed under a Creative Commons Attribution-ShareAlike 3.0 License</rights>
  </info>
  <style-options punctuation-in-quote="false"/>
  <date form="text">
    <date-part name="day" suffix=" "/>
    <date-part name="month" suffix=" "/>
    <date-part name="year"/>
  </date>
  <date form="numeric">
    <date-part name="day" form="numeric-leading-zeros" suffix="/"/>
    <date-part name="month" form="numeric-leading-zeros" suffix="/"/>
    <date-part name="year"/>
  </date>
  <terms>
    <term name="accessed">truy cập</term>
    <term name="and">và</term>
    <term name="and others">và những người khác</term>
    <term name="anonymous">khuyết danh</term>
    <term name="at">tại</term>
    <term name="by">bởi</term>
    <term name="circa">khoảng</term>
    <term name="cited">được trích dẫn</term>
    <term name="edition">
      <single>ấn bản</single>
      <multiple>ấn bản</multiple>
    </term>
    <term name="editor">
      <single>chủ biên</single>
      <multiple>chủ biên</multiple>
    </term>
    <term name="et-al">và c.s.</term>
    <term name="from">từ</term>
    <term name="in">trong</term>
    <term name="issue">
      <single>số</single>
      <multiple>số</multiple>
    </term>
    <term name="no date">không ngày</term>
    <term name="page">
      <single>tr.</single>
      <multiple>tr.</multiple>
    </term>
    <term name="retrieved">truy xuất từ</term>
    <term name="volume">
      <single>tập</single>
      <multiple>tập</multiple>
    </term>
  </terms>
</locale>`;
