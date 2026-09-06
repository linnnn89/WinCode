using MiniDesk.Core;

namespace MiniDesk.App
{
    public partial class MainWindow
    {
        private readonly MemoryService _memory = new MemoryService();

        public MainWindow()
        {
            _memory.Load();
        }
    }
}
