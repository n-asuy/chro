
import { FilesShell } from "./components/files-shell";
import { ProjectProvider } from "./context/project-context";

export const FilesLayout = () => {
  return (
    <ProjectProvider>
      <FilesShell />
    </ProjectProvider>
  );
};

export default FilesLayout;
