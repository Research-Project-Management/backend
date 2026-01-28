export const randomEmoji = () => {
  const emojis = [
    "😀","🙏","👌","🔥",
    "🚀","🌟","🎉","💡","😇",
    "🤖","👻","🐱","🐶",];
    return emojis[Math.floor(Math.random() * emojis.length)];
}