using Game.Logic;
using NUnit.Framework;

namespace Game.Tests
{
    public class SmokeTests
    {
        [Test]
        public void GameHasAName()
        {
            Assert.IsNotEmpty(GameInfo.Name);
        }
    }
}
