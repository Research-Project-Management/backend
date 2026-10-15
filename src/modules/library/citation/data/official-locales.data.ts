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
