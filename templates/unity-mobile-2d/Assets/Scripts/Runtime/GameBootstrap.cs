using Game.Logic;
using UnityEngine;

namespace Game.Runtime
{
    /// <summary>Entry point of the game scene. Views present the state the logic assembly owns; they hold no rules.</summary>
    public sealed class GameBootstrap : MonoBehaviour
    {
        private void Awake()
        {
            Application.targetFrameRate = {{FPS}};
            Debug.Log($"{GameInfo.Name} started");
        }
    }
}
