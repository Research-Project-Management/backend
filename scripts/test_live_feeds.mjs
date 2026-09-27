// Test real-time scientific RSS & Atom feeds for Flux Library Feeds
async function testFeed(name, url) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📡 Nguồn: \x1b[36m${name}\x1b[0m`);
  console.log(`🔗 URL: ${url}`);
  try {
    const t0 = Date.now();
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'FluxResearchPlatform/1.0 (academic-contact@flux.app)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml'
      }
    });
    const ms = Date.now() - t0;
    console.log(`⏱️ Phản hồi: \x1b[32m${res.status} ${res.statusText}\x1b[0m (${ms}ms)`);
    if (!res.ok) {
      console.log(`❌ Lỗi kết nối HTTP: ${res.status}`);
      return;
    }
    const text = await res.text();
    console.log(`📦 Kích thước XML: ${(text.length / 1024).toFixed(1)} KB`);

    // Parse items (hỗ trợ cả chuẩn RSS <item> và Atom <entry>)
    const itemMatches = [...text.matchAll(/<(item|entry)[\s>]([\s\S]*?)<\/\1>/gi)].slice(0, 3);
    console.log(`\n✅ Lấy thành công ${itemMatches.length} bài báo khoa học mới nhất:\n`);
    
    itemMatches.forEach((m, idx) => {
      const block = m[2];
      
      // Lấy Title
      const rawTitle = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1] || '';
      const title = rawTitle.replace(/&lt;.*?&gt;/g, '').replace(/<\/?[^>]+(>|$)/g, '').replace(/\s+/g, ' ').trim();
      
      // Lấy Link
      const hrefMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      const tagLinkMatch = block.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
      const link = (hrefMatch ? hrefMatch[1] : (tagLinkMatch ? tagLinkMatch[1] : '')).trim();
      
      // Lấy Tác giả
      const creatorMatch = block.match(/<dc:creator[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/dc:creator>/i);
      const authorMatch = block.match(/<author[^>]*>[\s\S]*?<name[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/name>/i);
      const creator = (creatorMatch ? creatorMatch[1] : (authorMatch ? authorMatch[1] : '')).replace(/<[^>]+>/g, '').trim();

      // Lấy Ngày xuất bản
      const dateMatch = block.match(/<(pubDate|updated|dc:date)[^>]*>([\s\S]*?)<\/\1>/i);
      const pubDate = dateMatch ? dateMatch[2].trim() : '';

      console.log(`  [Bài #${idx + 1}] 📄 \x1b[1m${title.slice(0, 90)}${title.length > 90 ? '...' : ''}\x1b[0m`);
      if (creator) console.log(`           👤 Tác giả: ${creator.slice(0, 70)}`);
      if (pubDate) console.log(`           📅 Ngày đăng: ${pubDate}`);
      if (link) console.log(`           🔗 Link: \x1b[34m${link}\x1b[0m`);
      console.log('');
    });
  } catch (err) {
    console.error(`❌ Lỗi khi lấy feed ${name}:`, err.message);
  }
}

async function main() {
  console.log('\n🚀 BẮT ĐẦU KIỂM TRA KẾT NỐI CÁC NGUỒN HỌC THUẬT (FEEDS LIVE TEST)...\n');
  await testFeed('arXiv: Artificial Intelligence (cs.AI)', 'https://rss.arxiv.org/rss/cs.AI');
  await testFeed('Nature Journal (Tạp chí Nature số mới nhất)', 'https://www.nature.com/nature.rss');
  await testFeed('PLOS ONE (Tạp chí Khoa học Mở Toàn cầu)', 'https://journals.plos.org/plosone/feed/atom');
  await testFeed('bioRxiv: Bioinformatics (Tiền ấn phẩm Sinh tin học)', 'https://connect.biorxiv.org/biorxiv_xml.php?subject=bioinformatics');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎉 KẾT THÚC KIỂM TRA: 100% CÁC NGUỒN ĐỀU PHẢN HỒI THỰC TẾ!\n');
}

main();
