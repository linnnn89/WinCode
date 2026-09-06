using MiniDesk.Core;

namespace MiniDesk.Infra
{
    public class SaveManager
    {
        public void Persist(MemoryService memory)
        {
            memory.Save();
        }
    }
}
