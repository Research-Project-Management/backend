const schema = require('../src/modules/library/types/data/zotero-schema.json');
const en = schema.locales['en-US'];

console.log('=== ZOTERO OFFICIAL ITEM TYPES & THEIR UNIQUE/BASE FIELDS ===');
const typesToExamine = ['journalArticle', 'conferencePaper', 'preprint', 'book', 'bookSection', 'thesis', 'report', 'webpage', 'patent', 'dataset'];

typesToExamine.forEach(typeName => {
  const it = schema.itemTypes.find(t => t.itemType === typeName);
  if (!it) return;
  console.log('\n----------------------------------------');
  console.log('ITEM TYPE:', typeName, '(' + en.itemTypes[typeName] + ')');
  console.log('Primary creator:', it.creatorTypes?.find(c => c.primary)?.creatorType || it.creatorTypes?.[0]?.creatorType);
  console.log('Creator types:', it.creatorTypes?.map(c => c.creatorType + (c.primary ? ' (*)' : '')).join(', '));
  console.log('Fields count:', it.fields?.length);
  const fieldList = it.fields.map(f => {
    const lbl = en.fields[f.field] || f.field;
    return f.baseField ? f.field + ' [base: ' + f.baseField + '] ("' + lbl + '")' : f.field + ' ("' + lbl + '")';
  });
  console.log('Fields:\n  ' + fieldList.join('\n  '));
});
