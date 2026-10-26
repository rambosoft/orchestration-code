using System.Collections;
using NUnit.Framework;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Game.Tests
{
    /// <summary>
    /// Starts the game the way a player does: loads the main scene (Assets/Scenes/Main.unity, the scene the Android build ships) and lets it settle.
    /// A reachability test boots here, reaches the feature it covers by simulated player input (click the button, tap the cell, press back) and asserts what the player would see.
    /// Building a screen or its view model directly in a test proves the class works, not that the running game can reach it; the orchestrator's verify gate requires this boot for every task that builds a screen.
    /// </summary>
    public static class SliceHarness
    {
        public const string MainScene = "Assets/Scenes/Main.unity";

        /// <summary>Loads the main scene in play mode and waits <paramref name="settleFrames"/> frames. Unity's test runner already fails the test on any logged error or exception during the boot.</summary>
        public static IEnumerator Boot(int settleFrames = 3)
        {
            var load = EditorSceneManager.LoadSceneAsyncInPlayMode(MainScene, new LoadSceneParameters(LoadSceneMode.Single));
            yield return load;
            Assert.IsTrue(SceneManager.GetActiveScene().isLoaded, "the main scene did not load: " + MainScene);
            for (var frame = 0; frame < settleFrames; frame++) yield return null;
        }

        /// <summary>The first active object of type T in the booted game, or null: what a test asserts on after it has reached a screen.</summary>
        public static T Find<T>() where T : Object
        {
            return Object.FindFirstObjectByType<T>();
        }
    }
}
