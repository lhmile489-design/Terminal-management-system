// 对应 src/main/services/EntryService.ts 第 1135–1414 行：install / mavenRun /
// packageWithProfile / spawnPackageSession / buildPackageCommand / spawnMavenGoal /
// buildMavenGoalCommand。
//
// 全部只产出 file + args 数组；goal 与 profile 都是固定枚举或过白名单的值，子命令硬编码。

package entries

import (
	"errors"
	"fmt"

	"mile-console/internal/contract"
	"mile-console/internal/detect"
	"mile-console/internal/platform"
)

// Install 即原版 install：依赖安装必须由用户显式发起（PRD §5.2）。
func (s *Service) Install(id string) (contract.EntryRuntime, error) {
	entry, ok := s.Get(id)
	if !ok {
		return contract.EntryRuntime{}, fmt.Errorf("条目不存在：%s", id)
	}
	// Spring Boot 依赖由 Maven/Gradle 在启动时自行处理，没有独立的「安装会话」
	if entry.Framework == contract.FrameworkSpringBoot {
		return contract.EntryRuntime{}, errors.New("Spring Boot 条目不支持 npm 安装会话")
	}
	if err := s.assertNotLive(entry, "安装依赖"); err != nil {
		return contract.EntryRuntime{}, err
	}
	return s.SpawnSession(entry, nil, contract.SessionKindInstall, nil)
}

// MavenRun 即原版 mavenRun：对 Spring Boot 条目执行 Maven / Gradle 构建目标。
func (s *Service) MavenRun(id string, goal contract.MavenGoal) (contract.EntryRuntime, error) {
	entry, ok := s.Get(id)
	if !ok {
		return contract.EntryRuntime{}, fmt.Errorf("条目不存在：%s", id)
	}
	if entry.Framework != contract.FrameworkSpringBoot {
		return contract.EntryRuntime{}, fmt.Errorf("mavenRun 只支持 Spring Boot 条目，当前框架：%s", entry.Framework)
	}
	// goal 白名单校验（防止渲染层传入非法值）
	valid := false
	for _, g := range contract.MavenGoals {
		if g == goal {
			valid = true
			break
		}
	}
	if !valid {
		return contract.EntryRuntime{}, fmt.Errorf("非法构建目标：%s", goal)
	}
	if err := s.assertNotLive(entry, "执行构建"); err != nil {
		return contract.EntryRuntime{}, err
	}
	return s.spawnMavenGoal(entry, goal)
}

// PackageWithProfile 即原版 packageWithProfile：带 profile 的打包（build 型会话）。
func (s *Service) PackageWithProfile(id string, profile *string) (contract.EntryRuntime, error) {
	entry, ok := s.Get(id)
	if !ok {
		return contract.EntryRuntime{}, fmt.Errorf("条目不存在：%s", id)
	}
	if entry.Framework != contract.FrameworkSpringBoot {
		return contract.EntryRuntime{}, errors.New("packageWithProfile 只支持 Spring Boot 条目")
	}
	if err := assertSafeProfile(profile); err != nil {
		return contract.EntryRuntime{}, err
	}
	if err := s.assertNotLive(entry, "打包"); err != nil {
		return contract.EntryRuntime{}, err
	}
	return s.spawnPackageSession(entry, profile)
}

// assertSafeProfile 即原版 assertSafeProfile：null 放行，其余过白名单且不超 64 字符。
func assertSafeProfile(profile *string) error {
	if profile == nil {
		return nil
	}
	if !SafeProfile.MatchString(*profile) || len(*profile) > 64 {
		return fmt.Errorf("Profile 名非法或过长：%s", *profile)
	}
	return nil
}

// spawnPackageSession 即原版：起一个 build 型会话，成功后扫 target/ 写 lastBuiltJar。
func (s *Service) spawnPackageSession(entry contract.LaunchEntry, profile *string) (contract.EntryRuntime, error) {
	cwd := resolveCwdOf(entry)
	if err := assertInsideEntry(entry, cwd); err != nil {
		return contract.EntryRuntime{}, err
	}
	cmd, err := s.buildPackageCommand(entry, cwd, profile)
	if err != nil {
		return contract.EntryRuntime{}, err
	}
	projectID := entry.ID
	session, err := s.sess.Create(contract.CreateSessionInput{
		Kind:      contract.SessionKindBuild,
		Cwd:       cwd,
		ProjectID: &projectID,
		Title:     entry.Name + " · " + cmd.Title,
		File:      cmd.File,
		Args:      cmd.Args,
		Env:       entry.Env,
	})
	if err != nil {
		return contract.EntryRuntime{}, err
	}
	if _, err := s.Update(entry.ID, func(e *contract.LaunchEntry) {
		at := s.opt.Now().UnixMilli()
		e.LastStartedAt = &at
	}); err != nil {
		return contract.EntryRuntime{}, err
	}
	s.mu.Lock()
	delete(s.lastErrorLine, entry.ID)
	pid, startedAt := session.Pid, session.StartedAt
	rt := contract.EntryRuntime{
		EntryID: entry.ID, Status: contract.EntryStarting, SessionID: session.ID,
		Pid: &pid, StartedAt: &startedAt,
	}
	s.runtimes[entry.ID] = rt
	// build 型会话不做端口捕获，直接标记 captured
	s.watches[session.ID] = &Watch{EntryID: entry.ID, Captured: true, IsPackage: true}
	s.mu.Unlock()
	return rt, nil
}

// spawnMavenGoal 即原版：构造并执行 Maven / Gradle goal 的会话（build 型，不做端口捕获）。
func (s *Service) spawnMavenGoal(entry contract.LaunchEntry, goal contract.MavenGoal) (contract.EntryRuntime, error) {
	cwd := resolveCwdOf(entry)
	if err := assertInsideEntry(entry, cwd); err != nil {
		return contract.EntryRuntime{}, err
	}
	cmd, err := s.BuildMavenGoalCommand(entry, cwd, goal)
	if err != nil {
		return contract.EntryRuntime{}, err
	}
	projectID := entry.ID
	session, err := s.sess.Create(contract.CreateSessionInput{
		Kind:      contract.SessionKindBuild,
		Cwd:       cwd,
		ProjectID: &projectID,
		Title:     entry.Name + " · " + cmd.Title,
		File:      cmd.File,
		Args:      cmd.Args,
		Env:       entry.Env,
	})
	if err != nil {
		return contract.EntryRuntime{}, err
	}
	if _, err := s.Update(entry.ID, func(e *contract.LaunchEntry) {
		at := s.opt.Now().UnixMilli()
		e.LastStartedAt = &at
	}); err != nil {
		return contract.EntryRuntime{}, err
	}
	s.mu.Lock()
	delete(s.lastErrorLine, entry.ID)
	pid, startedAt := session.Pid, session.StartedAt
	rt := contract.EntryRuntime{
		EntryID: entry.ID, Status: contract.EntryStarting, SessionID: session.ID,
		Pid: &pid, StartedAt: &startedAt,
	}
	s.runtimes[entry.ID] = rt
	s.watches[session.ID] = &Watch{EntryID: entry.ID, Captured: true}
	s.mu.Unlock()
	return rt, nil
}

// BuildPackageCommand 即原版 buildPackageCommand：带 profile 的打包命令。
// Maven 用 `-P` + profile 两个独立 args 元素；Gradle 用 `-P<profile>` 单个元素（Gradle 惯例）。
func (s *Service) BuildPackageCommand(entry contract.LaunchEntry, cwd string, profile *string) (LaunchCommand, error) {
	return s.buildPackageCommand(entry, cwd, profile)
}

func (s *Service) buildPackageCommand(entry contract.LaunchEntry, cwd string, profile *string) (LaunchCommand, error) {
	mode := entry.LaunchMode
	if mode == "" || !springBootModeSet[mode] {
		return LaunchCommand{}, errors.New("Spring Boot 条目缺少合法的启动方式（launchMode）")
	}
	if mode == contract.LaunchModeJar {
		return LaunchCommand{}, errors.New("jar 模式无内置构建命令，请手动构建后切换到 jar 启动方式")
	}
	var mavenProfileArgs, gradleProfileArgs []string
	profileLabel := ""
	if profile != nil {
		mavenProfileArgs = []string{"-P", *profile}
		gradleProfileArgs = []string{"-P" + *profile}
		profileLabel = *profile
	}
	wrapper := s.plat.WrapperFile()

	switch mode {
	case contract.LaunchModeMavenWrapper:
		path := detect.Join(cwd, wrapper.Maven)
		if !IsRunnable(s.plat, path) {
			return LaunchCommand{}, fmt.Errorf("未找到 %s", wrapper.Maven)
		}
		file, args := s.plat.WrapBatch(path, append([]string{"package"}, mavenProfileArgs...))
		title := "mvnw package"
		if profileLabel != "" {
			title = "mvnw package -P " + profileLabel
		}
		return LaunchCommand{File: file, Args: args, Title: title}, nil
	case contract.LaunchModeGradleWrapper:
		path := detect.Join(cwd, wrapper.Gradle)
		if !IsRunnable(s.plat, path) {
			return LaunchCommand{}, fmt.Errorf("未找到 %s", wrapper.Gradle)
		}
		file, args := s.plat.WrapBatch(path, append([]string{"build"}, gradleProfileArgs...))
		title := "gradlew build"
		if profileLabel != "" {
			title = "gradlew build -P" + profileLabel
		}
		return LaunchCommand{File: file, Args: args, Title: title}, nil
	case contract.LaunchModeSystemMaven:
		mvn, ok := s.which(s.plat.Binaries()[platform.BinaryMvn])
		if !ok {
			return LaunchCommand{}, errors.New("PATH 中找不到 mvn")
		}
		file, args := s.plat.WrapBatch(mvn, append([]string{"package"}, mavenProfileArgs...))
		title := "mvn package"
		if profileLabel != "" {
			title = "mvn package -P " + profileLabel
		}
		return LaunchCommand{File: file, Args: args, Title: title}, nil
	case contract.LaunchModeSystemGradle:
		gradle, ok := s.which(s.plat.Binaries()[platform.BinaryGradle])
		if !ok {
			return LaunchCommand{}, errors.New("PATH 中找不到 gradle")
		}
		file, args := s.plat.WrapBatch(gradle, append([]string{"build"}, gradleProfileArgs...))
		title := "gradle build"
		if profileLabel != "" {
			title = "gradle build -P" + profileLabel
		}
		return LaunchCommand{File: file, Args: args, Title: title}, nil
	}
	return LaunchCommand{}, errors.New("Spring Boot 条目缺少合法的启动方式（launchMode）")
}

// gradleTasks 即原版 GRADLE_TASK：Maven goal → Gradle task。
var gradleTasks = map[contract.MavenGoal]string{
	contract.MavenGoalClean:   "clean",
	contract.MavenGoalCompile: "compileJava",
	contract.MavenGoalPackage: "build",
	contract.MavenGoalTest:    "test",
	contract.MavenGoalInstall: "publishToMavenLocal",
	contract.MavenGoalVerify:  "check",
}

// BuildMavenGoalCommand 即原版 buildMavenGoalCommand：按 launchMode + goal 映射构建命令。
func (s *Service) BuildMavenGoalCommand(entry contract.LaunchEntry, cwd string, goal contract.MavenGoal) (LaunchCommand, error) {
	mode := entry.LaunchMode
	if mode == "" || !springBootModeSet[mode] {
		return LaunchCommand{}, errors.New("Spring Boot 条目缺少合法的启动方式（launchMode）")
	}
	if mode == contract.LaunchModeJar {
		return LaunchCommand{}, errors.New("jar 模式无内置构建命令，请手动构建后切换到 jar 启动方式")
	}
	wrapper := s.plat.WrapperFile()

	switch mode {
	case contract.LaunchModeMavenWrapper:
		path := detect.Join(cwd, wrapper.Maven)
		if !IsRunnable(s.plat, path) {
			return LaunchCommand{}, fmt.Errorf("未找到 %s，无法用 Maven Wrapper 执行构建", wrapper.Maven)
		}
		file, args := s.plat.WrapBatch(path, []string{string(goal)})
		return LaunchCommand{File: file, Args: args, Title: "mvnw " + string(goal)}, nil
	case contract.LaunchModeGradleWrapper:
		path := detect.Join(cwd, wrapper.Gradle)
		if !IsRunnable(s.plat, path) {
			return LaunchCommand{}, fmt.Errorf("未找到 %s，无法用 Gradle Wrapper 执行构建", wrapper.Gradle)
		}
		task := gradleTasks[goal]
		file, args := s.plat.WrapBatch(path, []string{task})
		return LaunchCommand{File: file, Args: args, Title: "gradlew " + task}, nil
	case contract.LaunchModeSystemMaven:
		mvn, ok := s.which(s.plat.Binaries()[platform.BinaryMvn])
		if !ok {
			return LaunchCommand{}, errors.New("PATH 中找不到 mvn")
		}
		file, args := s.plat.WrapBatch(mvn, []string{string(goal)})
		return LaunchCommand{File: file, Args: args, Title: "mvn " + string(goal)}, nil
	case contract.LaunchModeSystemGradle:
		gradle, ok := s.which(s.plat.Binaries()[platform.BinaryGradle])
		if !ok {
			return LaunchCommand{}, errors.New("PATH 中找不到 gradle")
		}
		task := gradleTasks[goal]
		file, args := s.plat.WrapBatch(gradle, []string{task})
		return LaunchCommand{File: file, Args: args, Title: "gradle " + task}, nil
	}
	return LaunchCommand{}, errors.New("Spring Boot 条目缺少合法的启动方式（launchMode）")
}

// SwitchPort 即原版 switchPort：走 Edit，端口范围、任务不收端口、运行中锁身份字段都由校形统一把关。
func (s *Service) SwitchPort(id string, newPort int) error {
	_, err := s.Edit(id, contract.EntryEdit{ExpectedPort: contract.PatchOf(newPort)})
	return err
}
